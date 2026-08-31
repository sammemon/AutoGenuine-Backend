import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  getConversations,
  getOrCreateConversation,
  getMessages,
  sendMessage,
  markRead,
  deleteMessage,
  clearConversation,
  getOwnerAllConversations,
  searchConversations,
  getOnlineUsers,
  getStaffUsers,
  getCustomerUsers,
  startSupportChat,
  sendSupportAIMessage,
  escalateConversation,
  assignSupportAgent,
  resolveSupportConversation,
  closeSupportConversation,
  reopenSupportConversation,
  rateSupportConversation,
  updateConversationRetention,
  getSupportEscalations,
  getSupportAnalytics,
} from '../controllers/chatController.js'

const router = Router()

// All chat routes require authentication
router.use(requireAuth)

// AI Support Endpoints
router.post('/support/start', startSupportChat)
router.post('/support/message', sendSupportAIMessage)
router.get('/support/escalations', getSupportEscalations)
router.get('/support/analytics', getSupportAnalytics)
router.post('/support/:id/escalate', escalateConversation)
router.post('/support/:id/assign', assignSupportAgent)
router.post('/support/:id/resolve', resolveSupportConversation)
router.post('/support/:id/close', closeSupportConversation)
router.post('/support/:id/reopen', reopenSupportConversation)
router.post('/support/:id/rate', rateSupportConversation)
router.patch('/conversations/:id/retention', updateConversationRetention)

// Search must be before :id routes to avoid conflict
router.get('/conversations/search', searchConversations)

// Store Owner global oversight route
router.get('/owner/all-conversations', getOwnerAllConversations)

router.get('/conversations', getConversations)
router.post('/conversations', getOrCreateConversation)
router.get('/conversations/:id/messages', getMessages)
router.patch('/conversations/:id/read', markRead)
router.patch('/conversations/:id/clear', clearConversation)

router.post('/messages', sendMessage)
router.delete('/messages/:id', deleteMessage)

router.get('/online-users', getOnlineUsers)
router.get('/staff-users', getStaffUsers)
router.get('/customer-users', getCustomerUsers)

export default router
