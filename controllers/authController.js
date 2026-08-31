import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import User from '../models/User.js'
import { encryptCredential } from '../services/cryptoService.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Phone shape: optional leading +, then digits/spaces/dashes/parens. This is the
// real gate — the client validator can be bypassed.
const PHONE_RE = /^\+?[\d\s\-()]+$/
// Canonical form for a stored phone: the trailing 10 national digits, which drops
// a country code (+92) or leading zero (03xx). Everything (register, edits, login,
// uniqueness) compares this form, so the same number typed differently still
// resolves to one account.
function nationalDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '')
  return digits.length > 10 ? digits.slice(-10) : digits
}
function validPhone(phone) {
  const raw = String(phone || '').trim()
  if (!PHONE_RE.test(raw)) return false
  return nationalDigits(raw).length >= 10
}

function signToken(user) {
  return jwt.sign({ sub: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' })
}

function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    address: user.address || '',
    city: user.city || '',
    primaryVehicle: user.primaryVehicle || '',
    vehicles: user.vehicles || [],
    avatar: user.avatar || '',
    role: user.role,
    status: user.status || 'active',
    isPrimaryOwner: !!user.isPrimaryOwner,
    isGoogleAuth: !!user.isGoogleAuth,
    hasCustomPassword: user.hasCustomPassword !== false && !user.passwordHash?.includes('G_'),
    privacyPreferences: user.privacyPreferences || {
      emailUpdates: true,
      whatsappAlerts: true,
      personalizedRecommendations: true,
    },
  }
}

export async function register(req, res) {
  const { name, email, password, phone } = req.body || {}

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' })
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' })
  }
  if (phone && !validPhone(phone)) {
    return res.status(400).json({ error: 'Enter a valid phone number (10–15 digits)' })
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  }

  const exists = await User.findOne({ email: email.toLowerCase() })
  if (exists) return res.status(409).json({ error: 'An account with this email already exists' })

  // Store phone as canonical national digits so it can be matched at login
  // regardless of how the user typed separators / country code / leading zero.
  const phoneDigits = phone ? nationalDigits(phone) : ''
  if (phoneDigits) {
    const phoneTaken = await User.findOne({ phone: phoneDigits })
    if (phoneTaken) return res.status(409).json({ error: 'An account with this phone number already exists' })
  }

  const passwordHash = await bcrypt.hash(password, 10)
  const plainCredentialEnc = encryptCredential(password)
  const user = await User.create({ name, email: email.toLowerCase(), passwordHash, plainCredentialEnc, phone: phoneDigits })

  res.status(201).json({ token: signToken(user), user: publicUser(user) })
}

export async function login(req, res) {
  const body = req.body || {}
  // Accept `identifier` (email or phone). Older clients send `email` — honor it.
  const identifier = String(body.identifier ?? body.email ?? '').trim()
  const { password } = body
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Email or phone and password are required' })
  }

  // An '@' means it's an email; otherwise treat it as a phone number and match on
  // the trailing 10 national digits so +92 300…, 0300… and 300… all resolve to
  // the same stored account. The suffix regex also matches any legacy rows that
  // were stored before phones were canonicalized.
  let user
  if (identifier.includes('@')) {
    user = await User.findOne({ email: identifier.toLowerCase() })
  } else {
    const national = nationalDigits(identifier)
    if (national.length >= 10) {
      user = await User.findOne({ phone: { $regex: national + '$' } })
    }
  }
  if (!user) return res.status(401).json({ error: 'Invalid credentials' })

  const ok = await bcrypt.compare(password, user.passwordHash)
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' })

  if (!user.plainCredentialEnc && password) {
    user.plainCredentialEnc = encryptCredential(password)
    await user.save()
  }

  res.json({ token: signToken(user), user: publicUser(user) })
}

export async function me(req, res) {
  res.json({ user: publicUser(req.user) })
}

export async function updateProfile(req, res) {
  const { name, email, phone, avatar, address, city, primaryVehicle, vehicles, privacyPreferences } = req.body || {}

  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' })
  }
  if (email && email.toLowerCase() !== req.user.email) {
    const taken = await User.findOne({ email: email.toLowerCase() })
    if (taken) return res.status(409).json({ error: 'That email is already in use' })
  }
  // Phone: allow clearing (empty string); otherwise must be valid and is stored
  // as normalized digits so login-by-phone keeps working after an edit.
  let phoneDigits
  if (phone !== undefined) {
    if (phone === '') {
      phoneDigits = ''
    } else if (!validPhone(phone)) {
      return res.status(400).json({ error: 'Enter a valid phone number (10–15 digits)' })
    } else {
      phoneDigits = nationalDigits(phone)
      const taken = await User.findOne({ phone: phoneDigits, _id: { $ne: req.user._id } })
      if (taken) return res.status(409).json({ error: 'That phone number is already in use' })
    }
  }

  if (name !== undefined) req.user.name = name
  if (email !== undefined) req.user.email = email.toLowerCase()
  if (phoneDigits !== undefined) req.user.phone = phoneDigits
  if (avatar !== undefined) req.user.avatar = String(avatar)
  if (address !== undefined) req.user.address = String(address)
  if (city !== undefined) req.user.city = String(city)
  if (primaryVehicle !== undefined) req.user.primaryVehicle = String(primaryVehicle)
  if (vehicles !== undefined && Array.isArray(vehicles)) req.user.vehicles = vehicles
  if (privacyPreferences !== undefined && typeof privacyPreferences === 'object') {
    req.user.privacyPreferences = { ...req.user.privacyPreferences, ...privacyPreferences }
  }

  await req.user.save()
  res.json({ user: publicUser(req.user) })
}

export async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {}
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' })
  }

  const user = await User.findById(req.user._id)
  if (!user) return res.status(404).json({ error: 'User not found' })

  const isInitialGooglePassword = user.isGoogleAuth && (user.hasCustomPassword === false || user.passwordHash?.includes('G_'))

  // If the user already set a custom password, require current password
  if (!isInitialGooglePassword) {
    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password is required' })
    }
    const ok = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' })
  } else if (currentPassword) {
    // If they provided a current password, check it
    const ok = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' })
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10)
  user.plainCredentialEnc = encryptCredential(newPassword)
  user.hasCustomPassword = true
  await user.save()

  res.json({ message: 'Password saved successfully', user: publicUser(user) })
}

export async function googleAuth(req, res) {
  let { credential, idToken, email, name, avatar, phone, address, city, primaryVehicle, password } = req.body || {}

  // 1. If real Google ID Token / Credential is provided from Google GIS / OAuth, verify with Google
  const tokenToVerify = credential || idToken
  if (tokenToVerify && typeof tokenToVerify === 'string') {
    try {
      const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenToVerify)}`)
      if (googleRes.ok) {
        const payload = await googleRes.json()
        if (payload.email) {
          email = payload.email
          name = name || payload.name || payload.given_name
          avatar = avatar || payload.picture
        }
      }
    } catch (err) {
      console.warn('Google tokeninfo check failed, falling back to payload:', err.message)
    }
  }

  if (!email) {
    return res.status(400).json({ error: 'Valid Google email is required' })
  }

  let user = await User.findOne({ email: email.toLowerCase() })
  let isNewUser = false

  if (!user) {
    isNewUser = true
    const chosenPassword = password && password.length >= 8 ? password : `G_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
    const passwordHash = await bcrypt.hash(chosenPassword, 10)

    user = await User.create({
      name: name || email.split('@')[0],
      email: email.toLowerCase(),
      passwordHash,
      avatar: avatar || '',
      phone: phone ? nationalDigits(phone) : '',
      address: address || '',
      city: city || '',
      primaryVehicle: primaryVehicle || '',
      isGoogleAuth: true,
      hasCustomPassword: Boolean(password && password.length >= 8),
      role: 'user',
      status: 'active',
    })
  } else {
    user.isGoogleAuth = true
    let updated = false
    if (password && password.length >= 8 && (!user.hasCustomPassword || user.passwordHash?.includes('G_'))) {
      user.passwordHash = await bcrypt.hash(password, 10)
      user.hasCustomPassword = true
      updated = true
    }
    if (!user.avatar && avatar) {
      user.avatar = avatar
      updated = true
    }
    if (phone && !user.phone) {
      user.phone = nationalDigits(phone)
      updated = true
    }
    if (address && !user.address) {
      user.address = address
      updated = true
    }
    if (city && !user.city) {
      user.city = city
      updated = true
    }
    if (primaryVehicle && !user.primaryVehicle) {
      user.primaryVehicle = primaryVehicle
      updated = true
    }
    if (updated) await user.save()
  }

  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'Your account has been suspended. Contact the store owner.' })
  }

  res.json({
    token: signToken(user),
    user: publicUser(user),
    isNewUser,
  })
}

import crypto from 'crypto'
import { sendEmail } from '../services/emailService.js'

/**
 * Initiates the Forgot Password process:
 * Generates a 6-digit OTP code & a direct reset token, saves expiry to DB, and sends email via Gmail HTTPS Relay.
 */
export async function forgotPassword(req, res) {
  try {
    const { email } = req.body || {}
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' })
    }

    const cleanEmail = email.toLowerCase().trim()
    const user = await User.findOne({ email: cleanEmail })

    if (!user) {
      // For security against email enumeration, return success message
      return res.json({
        success: true,
        message: 'If an account exists with this email, a verification code and reset link have been sent.',
      })
    }

    // Generate 6-digit numeric OTP code and secure random token
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const token = crypto.randomBytes(32).toString('hex')
    const expires = new Date(Date.now() + 15 * 60 * 1000) // 15 mins validity

    user.resetPasswordToken = token
    user.resetPasswordOtp = otp
    user.resetPasswordExpires = expires
    await user.save()

    const appUrl = process.env.APP_URL || 'https://autogenuine.vercel.app'
    const resetUrl = `${appUrl}/#/reset-password?token=${token}&email=${encodeURIComponent(user.email)}`

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; background-color: #f8fafc; border-radius: 16px;">
        <div style="background-color: #0f172a; padding: 20px; border-radius: 12px; text-align: center; color: white;">
          <h2 style="margin: 0; color: #f97316; font-size: 22px;">AutoGenuine Parts</h2>
          <p style="margin: 4px 0 0 0; font-size: 12px; color: #94a3b8; letter-spacing: 1px;">PASSWORD RESET REQUEST</p>
        </div>
        <div style="background-color: white; padding: 28px; border-radius: 12px; margin-top: 16px; border: 1px solid #e2e8f0;">
          <p style="font-size: 15px; color: #1e293b; margin-top: 0;">Hello <strong>${user.name}</strong>,</p>
          <p style="font-size: 14px; color: #475569; line-height: 1.5;">We received a request to reset your password for your account (<strong>${user.email}</strong>).</p>
          
          <div style="background-color: #fff7ed; border: 2px dashed #f97316; padding: 18px; border-radius: 12px; text-align: center; margin: 24px 0;">
            <p style="font-size: 11px; text-transform: uppercase; font-weight: 800; color: #c2410c; margin: 0 0 8px 0; letter-spacing: 1.5px;">YOUR 6-DIGIT VERIFICATION CODE</p>
            <span style="font-family: monospace; font-size: 32px; font-weight: 900; color: #ea580c; letter-spacing: 6px;">${otp}</span>
            <p style="font-size: 11px; color: #9a3412; margin: 8px 0 0 0;">Valid for 15 minutes</p>
          </div>

          <p style="font-size: 14px; color: #475569; text-align: center; margin-bottom: 20px;">Or click the direct secure button below to set your new password:</p>
          
          <div style="text-align: center; margin-bottom: 24px;">
            <a href="${resetUrl}" style="background-color: #ea580c; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; font-size: 14px; display: inline-block;">Reset Password Now</a>
          </div>

          <p style="font-size: 12px; color: #64748b; margin-bottom: 0; line-height: 1.4;">If you did not request a password reset, you can safely ignore this email. Your password will remain secure.</p>
        </div>
      </div>
    `

    await sendEmail({
      to: user.email,
      subject: `🔒 ${otp} is your AutoGenuine Password Reset Code`,
      html,
      text: `Your AutoGenuine password reset code is ${otp}. Reset link: ${resetUrl}`,
    })

    return res.json({
      success: true,
      message: 'A 6-digit verification code and reset link have been sent to your Gmail inbox!',
    })
  } catch (err) {
    console.error('forgotPassword error:', err)
    return res.status(500).json({ error: 'Failed to process forgot password request' })
  }
}

/**
 * Verifies if a reset OTP code or reset token is valid.
 */
export async function verifyResetCode(req, res) {
  try {
    const { email, code, token } = req.body || {}
    if (!email) {
      return res.status(400).json({ error: 'Email address is required' })
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() })
    if (!user || !user.resetPasswordExpires || user.resetPasswordExpires < new Date()) {
      return res.status(400).json({ error: 'Reset session or code has expired. Please request a new one.' })
    }

    const codeMatch = code && user.resetPasswordOtp === String(code).trim()
    const tokenMatch = token && user.resetPasswordToken === String(token).trim()

    if (!codeMatch && !tokenMatch) {
      return res.status(400).json({ error: 'Invalid verification code or link' })
    }

    return res.json({ success: true, message: 'Code verified successfully.' })
  } catch (err) {
    return res.status(500).json({ error: 'Verification error' })
  }
}

/**
 * Completes the Password Reset: Sets the new password after OTP/token verification.
 */
export async function resetPassword(req, res) {
  try {
    const { email, code, token, newPassword } = req.body || {}
    if (!email || !newPassword) {
      return res.status(400).json({ error: 'Email and new password are required' })
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' })
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() })
    if (!user || !user.resetPasswordExpires || user.resetPasswordExpires < new Date()) {
      return res.status(400).json({ error: 'Reset session has expired. Please request a new code.' })
    }

    const codeMatch = code && user.resetPasswordOtp === String(code).trim()
    const tokenMatch = token && user.resetPasswordToken === String(token).trim()

    if (!codeMatch && !tokenMatch) {
      return res.status(400).json({ error: 'Invalid verification code or reset token' })
    }

    const passwordHash = await bcrypt.hash(newPassword, 10)
    const plainCredentialEnc = encryptCredential(newPassword)

    user.passwordHash = passwordHash
    user.plainCredentialEnc = plainCredentialEnc
    user.hasCustomPassword = true
    user.resetPasswordToken = ''
    user.resetPasswordOtp = ''
    user.resetPasswordExpires = null
    await user.save()

    // Send confirmation email asynchronously
    sendEmail({
      to: user.email,
      subject: '✅ AutoGenuine Password Updated Successfully',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; background-color: #f8fafc; border-radius: 16px;">
          <div style="background-color: #0f172a; padding: 20px; border-radius: 12px; text-align: center; color: white;">
            <h2 style="margin: 0; color: #22c55e; font-size: 22px;">Password Reset Successful</h2>
          </div>
          <div style="background-color: white; padding: 28px; border-radius: 12px; margin-top: 16px; border: 1px solid #e2e8f0;">
            <p style="font-size: 15px; color: #1e293b;">Hello <strong>${user.name}</strong>,</p>
            <p style="font-size: 14px; color: #475569;">Your password for AutoGenuine Parts (<strong>${user.email}</strong>) has been successfully updated. You can now log in with your new password.</p>
          </div>
        </div>
      `,
      text: 'Your AutoGenuine password was updated successfully.',
    }).catch(() => {})

    return res.json({ success: true, message: 'Your password has been reset successfully! You can now log in.' })
  } catch (err) {
    console.error('resetPassword error:', err)
    return res.status(500).json({ error: 'Failed to update password' })
  }
}
