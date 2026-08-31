import AIManagerConversation from '../models/AIManagerConversation.js'
import AIStoreAction from '../models/AIStoreAction.js'
import Order from '../models/Order.js'
import Part from '../models/Part.js'
import Category from '../models/Category.js'
import {
  processStoreManagerChat,
  executeApprovedStoreAction,
} from '../services/aiStoreManagerService.js'
import { emitToStaff } from '../socket.js'

function isStaff(user) {
  return user?.role === 'admin' || user?.role === 'owner'
}

/**
 * POST /api/admin/ai-manager/chat
 */
export async function handleStoreManagerChat(req, res) {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ error: 'Staff access required for AI Store Manager.' })
    }

    const { prompt, imageUrl = '', conversationId } = req.body || {}
    if (!prompt && !imageUrl) {
      return res.status(400).json({ error: 'Prompt or image is required.' })
    }

    let conversation = null
    if (conversationId) {
      conversation = await AIManagerConversation.findOne({
        _id: conversationId,
        user: req.user._id,
      })
    }

    if (!conversation) {
      conversation = await AIManagerConversation.create({
        user: req.user._id,
        userName: req.user.name,
        userRole: req.user.role,
        title: prompt ? prompt.slice(0, 45) : 'AI Store Management Session',
        isTemporary: true,
        messages: [],
      })
    }

    // Append user message
    conversation.messages.push({
      role: 'user',
      text: prompt || (imageUrl ? 'Analyze this uploaded vehicle/part image' : ''),
      imageUrl: imageUrl || '',
    })

    // Process with Gemini Executive Engine
    const aiResult = await processStoreManagerChat({
      prompt: prompt || 'Analyze this image and create a product draft.',
      imageUrl,
      conversationHistory: conversation.messages.map((m) => ({
        role: m.role,
        text: m.text,
        imageUrl: m.imageUrl,
      })),
      user: req.user,
    })

    // Append assistant response
    conversation.messages.push({
      role: 'assistant',
      text: aiResult.text,
      toolsUsed: aiResult.toolsUsed,
      actionProposals: aiResult.actionProposals,
      productDraft: aiResult.productDraft,
    })

    await conversation.save()

    res.json({
      conversationId: conversation._id,
      text: aiResult.text,
      toolsUsed: aiResult.toolsUsed,
      actionProposals: aiResult.actionProposals,
      productDraft: aiResult.productDraft,
      messages: conversation.messages,
      isTemporary: conversation.isTemporary,
      savedPermanently: conversation.savedPermanently,
    })
  } catch (err) {
    console.error('handleStoreManagerChat error:', err)
    res.status(500).json({ error: err.message || 'AI Store Manager execution failed' })
  }
}

/**
 * POST /api/admin/ai-manager/execute-action
 */
export async function executeAction(req, res) {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ error: 'Staff access required.' })
    }

    const { actionId } = req.body || {}
    if (!actionId) {
      return res.status(400).json({ error: 'actionId is required.' })
    }

    const result = await executeApprovedStoreAction(actionId, req.user)

    // Notify all staff via Socket.IO
    try {
      emitToStaff('ai_action_executed', {
        actionId,
        actionType: result.action.actionType,
        title: result.action.title,
        executedBy: req.user.name,
      })
    } catch (e) {
      console.warn('Socket notification error:', e.message)
    }

    res.json({
      success: true,
      action: result.action,
      executionResult: result.executionResult,
    })
  } catch (err) {
    console.error('executeAction error:', err)
    res.status(500).json({ error: err.message || 'Failed to execute action.' })
  }
}

/**
 * POST /api/admin/ai-manager/reject-action
 */
export async function rejectAction(req, res) {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ error: 'Staff access required.' })
    }

    const { actionId, reason = '' } = req.body || {}
    const action = await AIStoreAction.findById(actionId)
    if (!action) {
      return res.status(404).json({ error: 'Action proposal not found.' })
    }

    action.status = 'rejected'
    action.rejectedAt = new Date()
    action.rejectionReason = reason || 'Rejected by Store Owner'
    await action.save()

    res.json({ success: true, action: action.toObject() })
  } catch (err) {
    console.error('rejectAction error:', err)
    res.status(500).json({ error: err.message || 'Failed to reject action.' })
  }
}

/**
 * GET /api/admin/ai-manager/insights
 * Real-time aggregated AI executive insights for the dashboard banner
 */
export async function getAIStoreInsights(req, res) {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ error: 'Staff access required.' })
    }

    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)

    const [curOrders, prevOrders, lowStockParts, outOfStockParts, pendingOrders] = await Promise.all([
      Order.find({ status: { $ne: 'cancelled' }, createdAt: { $gte: startOfMonth } }).lean(),
      Order.find({ status: { $ne: 'cancelled' }, createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } }).lean(),
      Part.find({ stock: { $gt: 0, $lte: 5 }, active: true }).lean(),
      Part.find({ stock: 0, active: true }).lean(),
      Order.find({ status: 'pending' }).countDocuments(),
    ])

    const curRev = curOrders.reduce((sum, o) => sum + (o.total || 0), 0)
    const prevRev = prevOrders.reduce((sum, o) => sum + (o.total || 0), 0)
    const growth = prevRev > 0 ? (((curRev - prevRev) / prevRev) * 100).toFixed(1) : curRev > 0 ? '+100.0' : '0.0'

    const insights = [
      {
        type: Number(growth) >= 0 ? 'growth' : 'warning',
        icon: Number(growth) >= 0 ? 'TrendingUp' : 'TrendingDown',
        title: Number(growth) >= 0 ? `Monthly Revenue Growth: +${growth}%` : `Monthly Revenue Pace: ${growth}%`,
        description: `Current month revenue is PKR ${curRev.toLocaleString()} vs PKR ${prevRev.toLocaleString()} baseline.`,
      },
      ...(lowStockParts.length > 0
        ? [
            {
              type: 'alert',
              icon: 'AlertTriangle',
              title: `${lowStockParts.length} Parts Critical Low Stock`,
              description: `Items including "${lowStockParts[0]?.name}" have <= 5 units remaining.`,
              actionPrompt: 'What products are low on stock and how much should I reorder?',
            },
          ]
        : []),
      ...(pendingOrders > 0
        ? [
            {
              type: 'orders',
              icon: 'ShoppingBag',
              title: `${pendingOrders} Orders Awaiting Dispatch`,
              description: 'Customer orders are waiting in pending/processing status.',
              actionPrompt: 'Show orders waiting for dispatch',
            },
          ]
        : []),
      {
        type: 'recommendation',
        icon: 'Sparkles',
        title: 'Executive Recommendation',
        description: 'Analyze best-selling brake pads and filters to capitalize on high-velocity automotive demand.',
        actionPrompt: 'What are our top-selling OEM parts this month and what should we stock more of?',
      },
    ]

    res.json({
      revenueThisMonth: curRev,
      revenueGrowthRate: `${growth}%`,
      lowStockCount: lowStockParts.length,
      pendingOrdersCount: pendingOrders,
      insights,
    })
  } catch (err) {
    console.error('getAIStoreInsights error:', err)
    res.status(500).json({ error: 'Failed to generate store insights' })
  }
}

/**
 * GET /api/admin/ai-manager/history
 */
export async function getActionHistory(req, res) {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ error: 'Staff access required.' })
    }

    const actions = await AIStoreAction.find()
      .sort({ createdAt: -1 })
      .limit(30)
      .populate('proposedBy', 'name email role')
      .populate('approvedBy', 'name email role')
      .lean()

    res.json({ actions })
  } catch (err) {
    console.error('getActionHistory error:', err)
    res.status(500).json({ error: 'Failed to fetch action history' })
  }
}

/**
 * GET /api/admin/ai-manager/conversation
 */
export async function getLatestConversation(req, res) {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ error: 'Staff access required.' })
    }

    const conversation = await AIManagerConversation.findOne({ user: req.user._id })
      .sort({ updatedAt: -1 })
      .lean()

    res.json({ conversation })
  } catch (err) {
    console.error('getLatestConversation error:', err)
    res.status(500).json({ error: 'Failed to load conversation' })
  }
}

/**
 * PATCH /api/admin/ai-manager/conversations/:id/retention
 */
export async function setConversationRetention(req, res) {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ error: 'Staff access required.' })
    }

    const { id } = req.params
    const { action = 'make_temporary', days = 3 } = req.body || {}

    const conv = await AIManagerConversation.findById(id)
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found.' })
    }

    if (action === 'discard') {
      await AIManagerConversation.deleteOne({ _id: id })
      return res.json({ success: true, discarded: true })
    }

    if (action === 'save_permanent') {
      conv.savedPermanently = true
      conv.isTemporary = false
      conv.expiresAt = null
      await conv.save()
      return res.json({ success: true, savedPermanently: true, isTemporary: false, conversation: conv.toObject() })
    }

    // Make temporary
    conv.savedPermanently = false
    conv.isTemporary = true
    conv.expiresAt = new Date(Date.now() + Math.max(1, Number(days)) * 24 * 60 * 60 * 1000)
    await conv.save()

    res.json({ success: true, isTemporary: true, expiresAt: conv.expiresAt, conversation: conv.toObject() })
  } catch (err) {
    console.error('setConversationRetention error:', err)
    res.status(500).json({ error: 'Failed to update retention' })
  }
}

/**
 * GET /api/admin/ai-manager/autopilot
 */
export async function getAutoPilotStatus(req, res) {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ error: 'Staff access required.' })
    }

    const { getSettingsDoc } = await import('../models/Settings.js')
    const settings = await getSettingsDoc()
    res.json({ autoPilot: settings.autoPilot || {} })
  } catch (err) {
    console.error('getAutoPilotStatus error:', err)
    res.status(500).json({ error: 'Failed to fetch Auto-Pilot status.' })
  }
}

/**
 * PUT /api/admin/ai-manager/autopilot
 */
export async function updateAutoPilotSettings(req, res) {
  try {
    if (req.user?.role !== 'owner') {
      return res.status(403).json({ error: 'Store Owner privileges required for Auto-Pilot mode.' })
    }

    const { getSettingsDoc } = await import('../models/Settings.js')
    const settings = await getSettingsDoc()
    const updates = req.body || {}

    settings.autoPilot = {
      ...(settings.autoPilot?.toObject ? settings.autoPilot.toObject() : settings.autoPilot || {}),
      ...updates,
      logs: settings.autoPilot?.logs || [],
    }

    await settings.save()

    // If enabled, run immediate initial cycle
    if (updates.enabled) {
      const { runAutoPilotCycle } = await import('../services/autoPilotService.js')
      runAutoPilotCycle().catch((e) => console.warn('AutoPilot immediate cycle error:', e.message))
    }

    res.json({ success: true, autoPilot: settings.autoPilot })
  } catch (err) {
    console.error('updateAutoPilotSettings error:', err)
    res.status(500).json({ error: 'Failed to update Auto-Pilot settings.' })
  }
}

/**
 * POST /api/admin/ai-manager/autopilot/run-now
 */
export async function triggerAutoPilotNow(req, res) {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ error: 'Staff access required.' })
    }

    const { runAutoPilotCycle } = await import('../services/autoPilotService.js')
    const result = await runAutoPilotCycle()
    res.json({ success: true, result })
  } catch (err) {
    console.error('triggerAutoPilotNow error:', err)
    res.status(500).json({ error: 'Failed to run Auto-Pilot cycle.' })
  }
}
