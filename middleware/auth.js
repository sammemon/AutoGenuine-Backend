import jwt from 'jsonwebtoken'
import User from '../models/User.js'

// Role hierarchy — higher number outranks lower. owner ⊇ admin ⊇ user.
const ROLE_RANK = { user: 1, admin: 2, owner: 3 }

// Verifies the Bearer JWT, loads the user, attaches to req.user.
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return res.status(401).json({ error: 'Not authenticated' })

    const payload = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.findById(payload.sub).select('-passwordHash')
    if (!user) return res.status(401).json({ error: 'User no longer exists' })
    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Your account has been suspended. Contact the store owner.' })
    }

    req.user = user
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// Guard by minimum role. Runs after requireAuth. requireRole('admin') lets
// admin and owner through; requireRole('owner') is owner-only.
export function requireRole(minRole) {
  const min = ROLE_RANK[minRole] || 99
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' })
    const rank = ROLE_RANK[req.user.role] || 0
    if (rank < min) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' })
    }
    next()
  }
}
