import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { requirePermission, PERMISSION as P } from '../middleware/permissions.js'
import {
  getStats,
  listUsers, updateUserRole, setUserStatus, deleteUser, resetUserPassword, getUserCredential,
  listAllOrders, updateOrderStatus,
  listAllParts, createPart, updatePart, deletePart, applyPromoCampaign, clearPromoCampaign,
  listAllCategories, createCategory, updateCategory, deleteCategory,
  listAllVehicles, createVehicle, updateVehicle, deleteVehicle,
  listMessages, deleteMessage,
  getAnalytics, getSettings, updateSettings, listAudit,
  listNotifications, markNotificationRead, markAllNotificationsRead,
  listWaitingCarts, sendAbandonedCartReminder,
} from '../controllers/adminController.js'
import {
  handleStoreManagerChat,
  executeAction,
  rejectAction,
  getAIStoreInsights,
  getActionHistory,
  getLatestConversation,
  setConversationRetention,
  getAutoPilotStatus,
  updateAutoPilotSettings,
  triggerAutoPilotNow,
} from '../controllers/aiStoreManagerController.js'

const router = Router()

// Every admin route needs a valid token first. Per-route authorization is then
// expressed as a single permission check — see middleware/permissions.js for the
// role→permission map (owner ⊋ admin). No scattered role string comparisons.
router.use(requireAuth)

// Dashboard & Notifications
router.get('/stats', requirePermission(P.VIEW_STATS), getStats)
router.get('/notifications', requirePermission(P.VIEW_DASHBOARD), listNotifications)
router.patch('/notifications/:id/read', requirePermission(P.VIEW_DASHBOARD), markNotificationRead)
router.post('/notifications/read-all', requirePermission(P.VIEW_DASHBOARD), markAllNotificationsRead)

// Users — listing/suspending is staff-level; role changes, credentials, and deletion are owner-only.
router.get('/users', requirePermission(P.VIEW_USERS), listUsers)
router.get('/users/:id/credential', requirePermission(P.SET_USER_ROLE), getUserCredential)
router.patch('/users/:id/status', requirePermission(P.SET_USER_STATUS), setUserStatus)
router.put('/users/:id/status', requirePermission(P.SET_USER_STATUS), setUserStatus)
router.put('/users/:id/role', requirePermission(P.SET_USER_ROLE), updateUserRole)
router.put('/users/:id/password', requirePermission(P.SET_USER_STATUS), resetUserPassword)
router.post('/users/:id/password', requirePermission(P.SET_USER_STATUS), resetUserPassword)
router.delete('/users/:id', requirePermission(P.DELETE_USER), deleteUser)

// Orders & Waiting Carts
router.get('/orders', requirePermission(P.VIEW_ORDERS), listAllOrders)
router.put('/orders/:id/status', requirePermission(P.UPDATE_ORDER), updateOrderStatus)
router.get('/waiting-carts', requirePermission(P.VIEW_ORDERS), listWaitingCarts)
router.post('/waiting-carts/:cartId/send-reminder', requirePermission(P.VIEW_ORDERS), sendAbandonedCartReminder)

// Parts & Promotions
router.get('/parts', requirePermission(P.MANAGE_PRODUCTS), listAllParts)
router.post('/parts', requirePermission(P.MANAGE_PRODUCTS), createPart)
router.put('/parts/:slug', requirePermission(P.MANAGE_PRODUCTS), updatePart)
router.delete('/parts/:slug', requirePermission(P.MANAGE_PRODUCTS), deletePart)
router.post('/promotions/apply-campaign', requirePermission(P.MANAGE_PRODUCTS), applyPromoCampaign)
router.post('/promotions/clear-campaign', requirePermission(P.MANAGE_PRODUCTS), clearPromoCampaign)

// Categories
router.get('/categories', requirePermission(P.MANAGE_CATEGORIES), listAllCategories)
router.post('/categories', requirePermission(P.MANAGE_CATEGORIES), createCategory)
router.put('/categories/:slug', requirePermission(P.MANAGE_CATEGORIES), updateCategory)
router.delete('/categories/:slug', requirePermission(P.MANAGE_CATEGORIES), deleteCategory)

// Vehicles
router.get('/vehicles', requirePermission(P.MANAGE_VEHICLES), listAllVehicles)
router.post('/vehicles', requirePermission(P.MANAGE_VEHICLES), createVehicle)
router.put('/vehicles/:id', requirePermission(P.MANAGE_VEHICLES), updateVehicle)
router.delete('/vehicles/:id', requirePermission(P.MANAGE_VEHICLES), deleteVehicle)

// Contact messages
router.get('/messages', requirePermission(P.VIEW_MESSAGES), listMessages)
router.delete('/messages/:id', requirePermission(P.DELETE_MESSAGE), deleteMessage)

// Owner-only: analytics, store settings, audit log.
router.get('/analytics', requirePermission(P.VIEW_ANALYTICS), getAnalytics)
router.get('/settings', requirePermission(P.MANAGE_SETTINGS), getSettings)
router.put('/settings', requirePermission(P.MANAGE_SETTINGS), updateSettings)
router.get('/audit', requirePermission(P.VIEW_AUDIT), listAudit)

// AI Store Manager & Business Automation
router.post('/ai-manager/chat', requirePermission(P.VIEW_DASHBOARD), handleStoreManagerChat)
router.post('/ai-manager/execute-action', requirePermission(P.VIEW_DASHBOARD), executeAction)
router.post('/ai-manager/reject-action', requirePermission(P.VIEW_DASHBOARD), rejectAction)
router.get('/ai-manager/insights', requirePermission(P.VIEW_DASHBOARD), getAIStoreInsights)
router.get('/ai-manager/history', requirePermission(P.VIEW_DASHBOARD), getActionHistory)
router.get('/ai-manager/conversation', requirePermission(P.VIEW_DASHBOARD), getLatestConversation)
router.patch('/ai-manager/conversations/:id/retention', requirePermission(P.VIEW_DASHBOARD), setConversationRetention)
router.get('/ai-manager/autopilot', requirePermission(P.VIEW_DASHBOARD), getAutoPilotStatus)
router.put('/ai-manager/autopilot', requirePermission(P.VIEW_DASHBOARD), updateAutoPilotSettings)
router.post('/ai-manager/autopilot/run-now', requirePermission(P.VIEW_DASHBOARD), triggerAutoPilotNow)

export default router
