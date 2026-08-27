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
