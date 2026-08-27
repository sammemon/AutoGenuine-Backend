// Centralized Role-Based Access Control.
//
// This is the single source of truth for "what can each role do". Routes should
// guard with requirePermission(<perm>) instead of scattering `role === 'owner'`
// checks around the codebase. The role→permission map mirrors the frontend copy
// in src/auth/permissions.js so the UI can hide what the API forbids — but the
// API is the real gate; the frontend copy is only for showing/hiding.
//
// Model note: AutoGenuine is a single-store platform, so the hierarchy is
//   user (customer)  <  admin (staff)  <  owner (full control)
// `owner` is the top role and can do everything; `admin` manages the catalog and
// orders and can view customers, but cannot manage staff, change roles, or delete
// users. Add SUPER_ADMIN / MANAGER / STAFF later by extending ROLES + PERMISSIONS
// only — no route code has to change.

export const ROLES = ['user', 'admin', 'owner']

// Every distinct capability in the platform.
export const PERMISSION = {
  VIEW_DASHBOARD: 'dashboard:view',
  VIEW_STATS: 'stats:view',

  VIEW_USERS: 'users:view',
  SET_USER_STATUS: 'users:set-status', // suspend / activate
  SET_USER_ROLE: 'users:set-role',
  DELETE_USER: 'users:delete',

  VIEW_ORDERS: 'orders:view',
  UPDATE_ORDER: 'orders:update',

  MANAGE_PRODUCTS: 'products:manage',
  MANAGE_CATEGORIES: 'categories:manage',
  MANAGE_VEHICLES: 'vehicles:manage',

  VIEW_MESSAGES: 'messages:view',
  DELETE_MESSAGE: 'messages:delete',

  // Owner-only, high-trust capabilities.
  VIEW_ANALYTICS: 'analytics:view',   // revenue, sales trends, top sellers
  MANAGE_SETTINGS: 'settings:manage', // store-wide configuration
  VIEW_AUDIT: 'audit:view',           // read the staff action log
}

const P = PERMISSION

// admin capabilities: run the store day-to-day, see who the customers are,
// and moderate customer accounts (suspend/activate) — but not manage staff.
const ADMIN_PERMISSIONS = [
  P.VIEW_DASHBOARD, P.VIEW_STATS,
  P.VIEW_USERS, P.SET_USER_STATUS,     // can SEE users + suspend customers, but not change roles/delete
  P.VIEW_ORDERS, P.UPDATE_ORDER,
  P.MANAGE_PRODUCTS, P.MANAGE_CATEGORIES, P.MANAGE_VEHICLES,
  P.VIEW_MESSAGES, P.DELETE_MESSAGE,
]

// owner = everything admin can do, PLUS staff management and the high-trust
// capabilities below. Strict superset of admin.
const OWNER_PERMISSIONS = [
  ...ADMIN_PERMISSIONS,
  P.SET_USER_ROLE, P.DELETE_USER,                    // manage staff
  P.VIEW_ANALYTICS, P.MANAGE_SETTINGS, P.VIEW_AUDIT, // financials, config, audit
]

export const ROLE_PERMISSIONS = {
  user: [],                 // customers have no dashboard permissions
  admin: ADMIN_PERMISSIONS,
  owner: OWNER_PERMISSIONS,
}

// Does this user hold this permission?
export function can(user, permission) {
  if (!user) return false
  const granted = ROLE_PERMISSIONS[user.role] || []
  return granted.includes(permission)
}

// All permissions for a role — handy for shipping the set to the client on login.
export function permissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || []
}

// Express guard. Runs after requireAuth. 403s if the user lacks the permission.
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' })
    if (!can(req.user, permission)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' })
    }
    next()
  }
}
