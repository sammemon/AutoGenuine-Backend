import crypto from 'node:crypto'

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'autogenuine-credential-secret-key-32'
const IV_LENGTH = 16

export function encryptCredential(text) {
  if (!text) return ''
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'autogenuine-salt', 32)
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
    let encrypted = cipher.update(String(text), 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return `${iv.toString('hex')}:${encrypted}`
  } catch (e) {
    console.error('encryptCredential error:', e.message)
    return ''
  }
}

export function decryptCredential(encryptedText) {
  if (!encryptedText || !encryptedText.includes(':')) return ''
  try {
    const [ivHex, encrypted] = encryptedText.split(':')
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'autogenuine-salt', 32)
    const iv = Buffer.from(ivHex, 'hex')
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch (err) {
    console.error('decryptCredential error:', err.message)
    return ''
  }
}
