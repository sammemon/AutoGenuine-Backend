import Conversation from '../models/Conversation.js'
import Message from '../models/Message.js'
import UserBlock from '../models/UserBlock.js'
import User from '../models/User.js'
import SupportEscalation from '../models/SupportEscalation.js'
import AuditLog from '../models/AuditLog.js'
import { getIO } from '../socket.js'
import { processCustomerMessageWithAI } from '../services/geminiService.js'
import { executeEscalation } from '../services/escalationService.js'

const MESSAGE_MAX_LENGTH = 4000
const ALLOWED_MESSAGE_TYPES = new Set(['text', 'image', 'file', 'product', 'order'])

function isStaff(user) {
  return user?.role === 'admin' || user?.role === 'owner'
}

function isParticipant(conversation, userId) {
  return conversation.participants.some((p) => String(p) === String(userId))
}

async function canUsersCommunicate(currentUser, targetUser, existingConversation = null) {
  if (!currentUser || !targetUser) return false
  if (targetUser.status === 'suspended') return false
  if (isStaff(currentUser) || isStaff(targetUser)) return true
  return Boolean(existingConversation)
}

export async function cleanupExpiredTemporaryConversations() {
  try {
    const now = new Date()
    const expired = await Conversation.find({
      isTemporary: true,
      savedPermanently: { $ne: true },
      expiresAt: { $lte: now, $ne: null },
    }).select('_id')

    if (expired.length > 0) {
      const expiredIds = expired.map((c) => c._id)
      await Message.deleteMany({ conversation: { $in: expiredIds } })
      await Conversation.deleteMany({ _id: { $in: expiredIds } })
      console.log(`[AutoGenuine AI] Cleaned up ${expiredIds.length} expired temporary conversations.`)
    }
  } catch (err) {
    console.warn('[AutoGenuine AI] Temporary chat cleanup notice:', err.message)
  }
}

// ────────────────────────────────────────────────────
// GET /api/chat/conversations
// List authenticated user's direct human conversations
// ────────────────────────────────────────────────────
export async function getConversations(req, res) {
  try {
    cleanupExpiredTemporaryConversations().catch(() => {})

    const userId = req.user._id
    const { isSupport, status } = req.query

    const filter = {
      participants: userId,
      isArchived: false,
      deletedFor: { $ne: userId },
      $or: [
        { isTemporary: { $ne: true } },
        { savedPermanently: true },
        { expiresAt: { $gt: new Date() } },
        { expiresAt: null },
      ],
    }

    if (typeof isSupport !== 'undefined') {
      filter.isSupport = isSupport === 'true'
    }
    if (status) {
      filter.supportStatus = status
    }

    const conversations = await Conversation.find(filter)
      .sort({ updatedAt: -1 })
      .populate('participants', 'name email avatar role status phone')
      .populate('assignedUser', 'name email avatar role')
      .lean()

    // Deduplicate direct conversations by participant pair to prevent duplicate chats with the same user
    const seenDirectKeys = new Set()
    const deduplicated = []

    for (const c of conversations) {
      if (c.type === 'direct' && !c.isSupport) {
        const sortedPartIds = (c.participants || [])
          .map((p) => String(p._id || p))
          .sort()
          .join('_')
        if (seenDirectKeys.has(sortedPartIds)) {
          continue
        }
        seenDirectKeys.add(sortedPartIds)
      }
      deduplicated.push(c)
    }

    // Resolve deleted status for lastMessage
    const lastMsgIds = deduplicated.map((c) => c.lastMessage?._id).filter(Boolean)
    const dbMessages = await Message.find({ _id: { $in: lastMsgIds } })
      .select('_id text deleted deletedByName deletedBy')
      .populate('deletedBy', 'role name')
      .lean()

    const msgMap = new Map(dbMessages.map((m) => [String(m._id), m]))

    // Attach per-user unread count & resolve deleted lastMessage
    const enriched = deduplicated.map((c) => {
      const entry = (c.unreadBy || []).find(
        (u) => String(u.user) === String(userId)
      )

      let lastMsg = c.lastMessage || {}
      const dbMsg = lastMsg._id ? msgMap.get(String(lastMsg._id)) : null

      if (dbMsg?.deleted || lastMsg.deleted) {
        const deletedRole = dbMsg?.deletedBy?.role || lastMsg.deletedByRole || ''
        const deletedLabel =
          deletedRole === 'owner'
            ? '🚫 Message deleted by Owner'
            : deletedRole === 'admin'
            ? '🚫 Message deleted by Admin'
            : dbMsg?.deletedByName
            ? `🚫 Message deleted by ${dbMsg.deletedByName}`
            : '🚫 This message was deleted'

        lastMsg = {
          ...lastMsg,
          text: deletedLabel,
          deleted: true,
          deletedByName: dbMsg?.deletedByName || lastMsg.deletedByName,
        }
      }

      return { ...c, lastMessage: lastMsg, myUnread: entry?.count || 0 }
    })

    res.json({ conversations: enriched })
  } catch (err) {
    console.error('getConversations error:', err.message)
    res.status(500).json({ error: 'Failed to load conversations' })
  }
}

// ────────────────────────────────────────────────────
// POST /api/chat/conversations
// Get-or-create a direct human 1:1 conversation
// ────────────────────────────────────────────────────
export async function getOrCreateConversation(req, res) {
  try {
    const userId = req.user._id
    const { participantId, orderRef, productSlug } = req.body

    if (!participantId) {
      return res.status(400).json({ error: 'participantId is required' })
    }

    if (String(participantId) === String(userId)) {
      return res.status(400).json({ error: 'Cannot start conversation with yourself' })
    }

    // Check target user exists
    const targetUser = await User.findById(participantId).select('name role status email avatar').lean()
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' })
    }
    if (targetUser.status === 'suspended') {
      return res.status(403).json({ error: 'This user is currently unavailable' })
    }

    // Check blocks (bidirectional)
    const blocked = await UserBlock.findOne({
      $or: [
        { blocker: userId, blocked: participantId },
        { blocker: participantId, blocked: userId },
      ],
    })
    if (blocked) {
      return res.status(403).json({ error: 'Unable to start conversation with this user' })
    }

    // Find existing direct conversation between these two users
    let conversation = await Conversation.findOne({
      type: 'direct',
      participants: { $all: [userId, participantId], $size: 2 },
    })
      .populate('participants', 'name email avatar role status phone')
      .populate('assignedUser', 'name email avatar role')

    if (!(await canUsersCommunicate(req.user, targetUser, conversation))) {
      return res.status(403).json({ error: 'You are not allowed to message this user' })
    }

    if (!conversation) {
      conversation = await Conversation.create({
        type: 'direct',
        participants: [userId, participantId],
        createdBy: userId,
        orderRef: orderRef || '',
        productSlug: productSlug || '',
        isSupport: false,
        supportStatus: 'human_active',
        unreadBy: [
          { user: userId, count: 0 },
          { user: participantId, count: 0 },
        ],
      })

      // Create initial conversation message
      const currentUser = req.user
      await Message.create({
        conversation: conversation._id,
        sender: userId,
        senderName: currentUser.name,
        senderRole: currentUser.role,
        type: 'system',
        text: `${currentUser.name} started a conversation${orderRef ? ` about order ${orderRef}` : ''}${productSlug ? ` about product ${productSlug}` : ''}`,
        linkedOrderRef: orderRef || '',
        linkedPartSlug: productSlug || '',
      })

      conversation = await Conversation.findById(conversation._id)
        .populate('participants', 'name email avatar role status phone')
        .populate('assignedUser', 'name email avatar role')
    } else {
      if (orderRef && conversation.orderRef !== orderRef) {
        conversation.orderRef = orderRef
        await conversation.save()
      }
      if (productSlug && conversation.productSlug !== productSlug) {
        conversation.productSlug = productSlug
        await conversation.save()
      }
    }

    const conv = conversation.toObject()
    const entry = (conv.unreadBy || []).find(
      (u) => String(u.user) === String(userId)
    )
    conv.myUnread = entry?.count || 0

    res.json({ conversation: conv })
  } catch (err) {
    console.error('getOrCreateConversation error:', err.message)
    res.status(500).json({ error: 'Failed to open conversation' })
  }
}

// ────────────────────────────────────────────────────
// POST /api/chat/support/start
// Dedicated AI Support Chatbot Session
// ────────────────────────────────────────────────────
export async function startSupportChat(req, res) {
  try {
    const user = req.user
    const userId = user._id
    const { orderRef = '', productSlug = '', category = 'general_support', initialMessage = '' } = req.body || {}

    // Find staff user (Owner / Admin) for link
    const staffUser = await User.findOne({ role: 'owner' }) || await User.findOne({ role: 'admin' })
    const staffId = staffUser ? staffUser._id : userId

    let conversation = await Conversation.findOne({
      createdBy: userId,
      isSupport: true,
      supportStatus: 'ai_active',
      isArchived: false,
    })
      .populate('participants', 'name email avatar role status phone')
      .populate('assignedUser', 'name email avatar role')

    const isNew = !conversation

    if (!conversation) {
      const participants = [userId]
      if (staffId && String(staffId) !== String(userId)) {
        participants.push(staffId)
      }

      const isStaffUser = user.role === 'owner' || user.role === 'admin'
      const isTemp = req.body?.isTemporary !== undefined ? Boolean(req.body.isTemporary) : isStaffUser
      const expireDate = isTemp ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) : null

      conversation = await Conversation.create({
        type: 'direct',
        participants,
        createdBy: userId,
        orderRef,
        productSlug,
        isSupport: true,
        isTemporary: isTemp,
        savedPermanently: !isTemp,
        expiresAt: expireDate,
        supportStatus: 'ai_active',
        supportCategory: category || (orderRef ? 'order_support' : productSlug ? 'product_support' : 'general_support'),
        priority: 'medium',
        aiHandled: true,
        escalated: false,
        unreadBy: [
          { user: userId, count: 0 },
          ...(staffId && String(staffId) !== String(userId) ? [{ user: staffId, count: 0 }] : []),
        ],
      })

      let greetingText = `Hello ${user.name}! I am AutoGenuine's AI Support Assistant. I can help you look up order statuses, tracking, parts fitment, payments, and store policies.`
      if (orderRef) {
        greetingText = `Hello ${user.name}! I see you have a question regarding order #${orderRef}. Let me pull up your order details. How can I assist you with this order?`
      } else if (productSlug) {
        greetingText = `Hello ${user.name}! I see you're inquiring about genuine part "${productSlug}". How can I help you check compatibility, stock, or price?`
      }

      const greetingMessage = await Message.create({
        conversation: conversation._id,
        sender: null,
        senderName: 'AutoGenuine AI',
        senderRole: 'ai',
        isAI: true,
        type: 'text',
        text: greetingText,
        readBy: [{ user: userId, readAt: new Date() }],
      })

      conversation.lastMessage = {
        _id: greetingMessage._id,
        text: greetingText.substring(0, 100),
        senderName: 'AutoGenuine AI',
        type: 'text',
        createdAt: greetingMessage.createdAt,
      }
      await conversation.save()

      conversation = await Conversation.findById(conversation._id)
        .populate('participants', 'name email avatar role status phone')
        .populate('assignedUser', 'name email avatar role')
    }

    if (initialMessage && initialMessage.trim()) {
      const cleanText = initialMessage.trim()
      await Message.create({
        conversation: conversation._id,
        sender: userId,
        senderName: user.name,
        senderRole: user.role,
        type: 'text',
        text: cleanText,
        linkedOrderRef: orderRef || conversation.orderRef || '',
        linkedPartSlug: productSlug || conversation.productSlug || '',
        readBy: [{ user: userId, readAt: new Date() }],
      })

      const aiResult = await processCustomerMessageWithAI({
        conversation,
        user,
        customerMessageText: cleanText,
      })

      const aiMessage = await Message.create({
        conversation: conversation._id,
        sender: null,
        senderName: 'AutoGenuine AI',
        senderRole: 'ai',
        isAI: true,
        type: 'text',
        text: aiResult.aiText,
        aiMetadata: {
          toolsUsed: aiResult.toolsUsed,
          escalated: aiResult.shouldEscalate,
          reason: aiResult.escalation?.reason,
          recommendedAction: aiResult.escalation?.recommendedAction,
        },
        readBy: [{ user: userId, readAt: new Date() }],
      })

      conversation.lastMessage = {
        _id: aiMessage._id,
        text: aiResult.aiText.substring(0, 100),
        senderName: 'AutoGenuine AI',
        type: 'text',
        createdAt: aiMessage.createdAt,
      }
      await conversation.save()

      if (aiResult.shouldEscalate && aiResult.escalation) {
        await executeEscalation({
          conversationId: conversation._id,
          escalation: aiResult.escalation,
          customerId: userId,
          customerName: user.name,
          customerEmail: user.email,
        })
      }
    }

    const messages = await Message.find({ conversation: conversation._id })
      .sort({ createdAt: 1 })
      .populate('sender', 'name avatar role')
      .lean()

    res.json({ conversation: conversation.toObject(), messages, isNew })
  } catch (err) {
    console.error('startSupportChat error:', err.message)
    res.status(500).json({ error: 'Failed to start support session' })
  }
}

// ────────────────────────────────────────────────────
// POST /api/chat/support/message
// Send a message directly to AI in AI Support screen
// ────────────────────────────────────────────────────
export async function sendSupportAIMessage(req, res) {
  try {
    const user = req.user
    const userId = user._id
    const { conversationId, text, orderRef = '', productSlug = '' } = req.body

    const cleanText = (text || '').trim()
    if (!cleanText) {
      return res.status(400).json({ error: 'Message text is required' })
    }

    let conversation = conversationId ? await Conversation.findById(conversationId) : null
    if (!conversation) {
      const staffUser = await User.findOne({ role: 'owner' }) || await User.findOne({ role: 'admin' })
      const staffId = staffUser ? staffUser._id : userId

      conversation = await Conversation.create({
        type: 'direct',
        participants: [userId, ...(staffId && String(staffId) !== String(userId) ? [staffId] : [])],
        createdBy: userId,
        orderRef,
        productSlug,
        isSupport: true,
        supportStatus: 'ai_active',
        supportCategory: orderRef ? 'order_support' : productSlug ? 'product_support' : 'general_support',
        unreadBy: [{ user: userId, count: 0 }],
      })
    }

    // Save user message
    const userMessage = await Message.create({
      conversation: conversation._id,
      sender: userId,
      senderName: user.name,
      senderRole: user.role,
      type: 'text',
      text: cleanText,
      linkedOrderRef: orderRef || conversation.orderRef || '',
      linkedPartSlug: productSlug || conversation.productSlug || '',
      readBy: [{ user: userId, readAt: new Date() }],
    })

    // Process with Gemini AI
    const aiResult = await processCustomerMessageWithAI({
      conversation,
      user,
      customerMessageText: cleanText,
    })

    // Save AI message
    const aiMessage = await Message.create({
      conversation: conversation._id,
      sender: null,
      senderName: 'AutoGenuine AI',
      senderRole: 'ai',
      isAI: true,
      type: 'text',
      text: aiResult.aiText,
      aiMetadata: {
        toolsUsed: aiResult.toolsUsed,
        escalated: aiResult.shouldEscalate,
        reason: aiResult.escalation?.reason,
        recommendedAction: aiResult.escalation?.recommendedAction,
        productData: aiResult.productData || null,
        orderData: aiResult.orderData || null,
      },
      readBy: [{ user: userId, readAt: new Date() }],
    })

    conversation.lastMessage = {
      _id: aiMessage._id,
      text: aiResult.aiText.substring(0, 100),
      senderName: 'AutoGenuine AI',
      type: 'text',
      createdAt: aiMessage.createdAt,
    }
    await conversation.save()

    let escalationDoc = null
    let targetStaffUser = null

    if (aiResult.shouldEscalate && aiResult.escalation) {
      const escRes = await executeEscalation({
        conversationId: conversation._id,
        escalation: aiResult.escalation,
        customerId: userId,
        customerName: user.name,
        customerEmail: user.email,
      })
      escalationDoc = escRes.escalation

      // Find target staff member to connect with
      const targetRole = aiResult.escalation.target === 'owner' ? 'owner' : 'admin'
      targetStaffUser = await User.findOne({ role: targetRole, status: 'active' }).select('_id name email role avatar').lean()
    }

    res.json({
      userMessage: userMessage.toObject(),
      aiMessage: aiMessage.toObject(),
      conversation: conversation.toObject(),
      shouldEscalate: aiResult.shouldEscalate,
      escalation: aiResult.escalation,
      targetStaffUser,
    })
  } catch (err) {
    console.error('sendSupportAIMessage error:', err.message)
    res.status(500).json({ error: 'Failed to process AI message' })
  }
}

// ────────────────────────────────────────────────────
// GET /api/chat/conversations/:id/messages
// Paginated messages (cursor-based, newest first)
// ────────────────────────────────────────────────────
export async function getMessages(req, res) {
  try {
    const userId = req.user._id
    const isOwner = req.user.role === 'owner'
    const isAdmin = req.user.role === 'admin'
    const { id: conversationId } = req.params
    const { before, limit: limitParam } = req.query
    const limit = Math.min(parseInt(limitParam) || 30, 50)

    const conversation = await Conversation.findById(conversationId).lean()
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }
    if (!isParticipant(conversation, userId) && !isOwner && !isAdmin) {
      return res.status(403).json({ error: 'You are not a participant' })
    }

    const query = { conversation: conversationId }
    if (before) {
      query._id = { $lt: before }
    }

    if (!isOwner && !isAdmin) {
      const clearEntry = (conversation.clearedBy || []).find((c) => String(c.user) === String(userId))
      if (clearEntry?.clearedAt) {
        query.createdAt = { $gt: clearEntry.clearedAt }
      }
      query.deletedFor = { $ne: userId }
    }

    const rawMessages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .populate('sender', 'name avatar role')
      .lean()

    const hasMore = rawMessages.length > limit
    if (hasMore) rawMessages.pop()

    const messages = rawMessages.map((m) => {
      if (m.deleted && !isOwner) {
        return {
          ...m,
          text: '',
          attachments: [],
          originalText: undefined,
        }
      }
      return m
    })

    messages.reverse()

    res.json({ messages, hasMore })
  } catch (err) {
    console.error('getMessages error:', err.message)
    res.status(500).json({ error: 'Failed to load messages' })
  }
}

// ────────────────────────────────────────────────────
// POST /api/chat/messages
// Send a direct message in a human conversation
// ────────────────────────────────────────────────────
export async function sendMessage(req, res) {
  try {
    const userId = req.user._id
    const user = req.user
    const { conversationId, text, type = 'text', tempId, linkedPartSlug = '', linkedOrderRef = '', attachments = [] } = req.body

    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' })
    }
    const cleanText = typeof text === 'string' ? text.trim().replace(/\s+\n/g, '\n') : ''
    const validAttachments = Array.isArray(attachments) ? attachments.filter((a) => a && a.url) : []

    if (!cleanText && validAttachments.length === 0) {
      return res.status(400).json({ error: 'Message text or attachment is required' })
    }
    if (cleanText.length > MESSAGE_MAX_LENGTH) {
      return res.status(400).json({ error: `Message must be ${MESSAGE_MAX_LENGTH} characters or fewer` })
    }
    if (!ALLOWED_MESSAGE_TYPES.has(type)) {
      return res.status(400).json({ error: 'Unsupported message type' })
    }

    let conversation = await Conversation.findById(conversationId)
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    if (conversation.supportStatus === 'resolved') {
      return res.status(400).json({ error: 'This conversation is marked as resolved. Please click Reopen Ticket to send further messages.' })
    }

    if (isStaff(user) && !isParticipant(conversation, userId)) {
      conversation.participants.push(userId)
      await conversation.save()
    } else if (!isParticipant(conversation, userId)) {
      return res.status(403).json({ error: 'You are not a participant' })
    }

    const otherParticipants = conversation.participants.filter((p) => String(p) !== String(userId))
    const blockExists = await UserBlock.findOne({
      $or: otherParticipants.map((p) => ({ blocker: p, blocked: userId })),
    })
    if (blockExists) {
      return res.status(403).json({ error: 'You cannot send messages in this conversation' })
    }

    const messageType = validAttachments.length > 0 && type === 'text' ? 'image' : type

    const message = await Message.create({
      conversation: conversationId,
      sender: userId,
      senderName: user.name,
      senderRole: user.role,
      type: messageType,
      text: cleanText,
      attachments: validAttachments,
      linkedPartSlug: linkedPartSlug || conversation.productSlug || '',
      linkedOrderRef: linkedOrderRef || conversation.orderRef || '',
      readBy: [{ user: userId, readAt: new Date() }],
    })

    const previewText = cleanText || (validAttachments.length > 0 ? '📷 Image' : (linkedPartSlug ? '📦 Part Inquiry' : (linkedOrderRef ? '🧾 Order Inquiry' : 'New message')))

    const updateOps = {
      lastMessage: {
        _id: message._id,
        text: previewText.substring(0, 100),
        sender: userId,
        senderName: user.name,
        type: message.type,
        createdAt: message.createdAt,
      },
    }

    for (const pid of conversation.participants) {
      if (String(pid) !== String(userId)) {
        await Conversation.updateOne(
          { _id: conversationId, 'unreadBy.user': pid },
          { $inc: { 'unreadBy.$.count': 1 }, $set: updateOps }
        )
      }
    }
    await Conversation.updateOne({ _id: conversationId }, { $set: updateOps })

    const populatedMessage = await Message.findById(message._id)
      .populate('sender', 'name avatar role')
      .lean()

    const io = getIO()
    if (io) {
      io.to(`conv_${conversationId}`).emit('receive_message', {
        ...populatedMessage,
        tempId,
      })

      const updatedConv = await Conversation.findById(conversationId)
        .populate('participants', 'name email avatar role status phone')
        .populate('assignedUser', 'name email avatar role')
        .lean()

      for (const pid of conversation.participants) {
        const entry = (updatedConv.unreadBy || []).find((u) => String(u.user) === String(pid))
        io.to(`user_${pid}`).emit('conversation_updated', {
          ...updatedConv,
          myUnread: entry?.count || 0,
        })
      }
    }

    res.status(201).json({ message: populatedMessage })
  } catch (err) {
    console.error('sendMessage error:', err.message)
    res.status(500).json({ error: 'Failed to send message' })
  }
}

// ────────────────────────────────────────────────────
// POST /api/chat/support/:id/escalate
// Explicit Escalation to Human Agent
// ────────────────────────────────────────────────────
export async function escalateConversation(req, res) {
  try {
    const { id: conversationId } = req.params
    const { reason, target = 'owner', category = 'general_support', priority = 'high', summary = '' } = req.body || {}

    const conversation = await Conversation.findById(conversationId)
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    const result = await executeEscalation({
      conversationId,
      escalation: {
        reason: reason || 'Customer requested human assistance',
        target,
        category,
        priority,
        customerSummary: summary || reason || 'Customer transferred from AI support.',
        recommendedAction: 'Review customer context and reply directly.',
      },
      customerId: req.user._id,
      customerName: req.user.name,
      customerEmail: req.user.email,
    })

    // Find staff user to redirect to
    const targetRole = target === 'owner' ? 'owner' : 'admin'
    const staffUser = await User.findOne({ role: targetRole, status: 'active' }).select('_id name role email avatar').lean()

    res.json({
      success: true,
      escalation: result.escalation,
      conversation: result.conversation,
      staffUser,
    })
  } catch (err) {
    console.error('escalateConversation error:', err.message)
    res.status(500).json({ error: 'Failed to escalate conversation' })
  }
}

// ────────────────────────────────────────────────────
// POST /api/chat/support/:id/assign
// ────────────────────────────────────────────────────
export async function assignSupportAgent(req, res) {
  try {
    const staffUser = req.user
    if (!isStaff(staffUser)) {
      return res.status(403).json({ error: 'Staff access required' })
    }

    const { id: conversationId } = req.params
    const conversation = await Conversation.findById(conversationId)
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    if (!conversation.participants.some((p) => String(p) === String(staffUser._id))) {
      conversation.participants.push(staffUser._id)
    }

    conversation.assignedUser = staffUser._id
    conversation.assignedRole = staffUser.role
    conversation.supportStatus = 'human_active'
    await conversation.save()

    await SupportEscalation.updateMany(
      { conversation: conversationId, status: 'pending' },
      { $set: { assignedTo: staffUser._id, status: 'in_progress' } }
    )

    const roleTitle = staffUser.role === 'owner' ? 'Store Owner' : 'Store Admin'
    const systemMsg = await Message.create({
      conversation: conversationId,
      sender: staffUser._id,
      senderName: staffUser.name,
      senderRole: staffUser.role,
      type: 'system',
      text: `👋 ${staffUser.name} (${roleTitle}) joined the conversation.`,
    })

    const io = getIO()
    if (io) {
      io.to(`conv_${conversationId}`).emit('agent_assigned', {
        conversationId,
        agent: { _id: staffUser._id, name: staffUser.name, role: staffUser.role },
      })
      io.to(`conv_${conversationId}`).emit('receive_message', systemMsg.toObject())
      io.to('staff_room').emit('support_status_changed', {
        conversationId,
        supportStatus: 'human_active',
        assignedUser: staffUser._id,
      })
    }

    res.json({ success: true, conversation: conversation.toObject() })
  } catch (err) {
    console.error('assignSupportAgent error:', err.message)
    res.status(500).json({ error: 'Failed to assign agent' })
  }
}

// ────────────────────────────────────────────────────
// POST /api/chat/support/:id/resolve
// ────────────────────────────────────────────────────
export async function resolveSupportConversation(req, res) {
  try {
    const user = req.user
    if (!isStaff(user)) {
      return res.status(403).json({ error: 'Only Store Staff (Admin / Owner) can resolve tickets' })
    }

    const { id: conversationId } = req.params
    const { resolutionNote = 'Resolved by staff' } = req.body || {}

    const conversation = await Conversation.findById(conversationId)
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    conversation.supportStatus = 'resolved'
    conversation.resolvedBy = user._id
    conversation.resolvedByName = user.name
    conversation.resolvedAt = new Date()
    conversation.resolutionNote = resolutionNote
    await conversation.save()

    await SupportEscalation.updateMany(
      { conversation: conversationId, status: { $ne: 'resolved' } },
      {
        $set: {
          status: 'resolved',
          resolvedAt: new Date(),
          resolvedBy: user._id,
          resolutionNote,
        },
      }
    )

    const systemMsg = await Message.create({
      conversation: conversationId,
      sender: user._id,
      senderName: user.name,
      senderRole: user.role,
      type: 'system',
      text: `✅ Conversation marked as resolved by ${user.name}. Note: ${resolutionNote}`,
      resolutionData: {
        resolvedByName: user.name,
        resolvedByRole: user.role,
        note: resolutionNote,
      },
    })

    const io = getIO()
    if (io) {
      io.to(`conv_${conversationId}`).emit('support_status_changed', {
        conversationId,
        supportStatus: 'resolved',
        resolvedByName: user.name,
      })
      io.to(`conv_${conversationId}`).emit('receive_message', systemMsg.toObject())
    }

    res.json({ success: true, conversation: conversation.toObject() })
  } catch (err) {
    console.error('resolveSupportConversation error:', err.message)
    res.status(500).json({ error: 'Failed to resolve conversation' })
  }
}

// ────────────────────────────────────────────────────
// POST /api/chat/support/:id/reopen
// ────────────────────────────────────────────────────
export async function reopenSupportConversation(req, res) {
  try {
    const user = req.user
    const isStaffUser = isStaff(user)
    const { id: conversationId } = req.params
    const { reason = isStaffUser ? 'Reopened by staff' : 'Customer requested to reopen ticket' } = req.body || {}

    const conversation = await Conversation.findById(conversationId)
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    if (!isStaffUser) {
      // Customer submitting a Reopen Request to Admin/Owner
      conversation.supportStatus = 'reopen_requested'
      conversation.escalated = true
      conversation.escalationReason = `Customer Reopen Request: ${reason}`
      await conversation.save()

      await SupportEscalation.findOneAndUpdate(
        { conversation: conversationId },
        {
          $set: {
            status: 'pending',
            reopenedAt: new Date(),
            reopenReason: reason,
            priority: 'high',
            reason: `Reopen Request: ${reason}`,
          },
        },
        { upsert: true, new: true }
      )

      const systemMsg = await Message.create({
        conversation: conversationId,
        sender: user._id,
        senderName: user.name,
        senderRole: user.role,
        type: 'system',
        text: `📩 Reopen request submitted by ${user.name}. Reason: ${reason}. Awaiting Staff review & approval.`,
      })

      const io = getIO()
      if (io) {
        io.to(`conv_${conversationId}`).emit('support_status_changed', {
          conversationId,
          supportStatus: 'reopen_requested',
          requestedBy: user.name,
        })
        io.to(`conv_${conversationId}`).emit('receive_message', systemMsg.toObject())
        io.to('staff_room').emit('support_escalated', {
          conversationId,
          customerName: user.name,
          reason: `Reopen Requested: ${reason}`,
          priority: 'high',
        })
      }

      return res.json({
        success: true,
        conversation: conversation.toObject(),
        status: 'reopen_requested',
        message: 'Reopen request submitted to store staff for approval.',
      })
    }

    // Staff directly approving and reopening
    conversation.supportStatus = 'human_active'
    conversation.escalated = true
    await conversation.save()

    const existingEsc = await SupportEscalation.findOne({ conversation: conversationId })
    if (existingEsc) {
      existingEsc.status = 'in_progress'
      existingEsc.reopenedAt = new Date()
      existingEsc.reopenReason = reason
      await existingEsc.save()
    } else {
      await SupportEscalation.create({
        conversation: conversationId,
        customer: conversation.participants.find((p) => String(p) !== String(user._id)) || user._id,
        customerName: user.name,
        customerEmail: user.email,
        reason: `Reopened Ticket: ${reason}`,
        status: 'in_progress',
        priority: 'high',
        assignedRole: 'admin',
      })
    }

    const systemMsg = await Message.create({
      conversation: conversationId,
      sender: user._id,
      senderName: user.name,
      senderRole: user.role,
      type: 'system',
      text: `🔄 Conversation reopened and approved by staff (${user.name}). Reason: ${reason}`,
    })

    const io = getIO()
    if (io) {
      io.to(`conv_${conversationId}`).emit('support_status_changed', {
        conversationId,
        supportStatus: 'human_active',
        reopenedBy: user.name,
      })
      io.to(`conv_${conversationId}`).emit('receive_message', systemMsg.toObject())
    }

    res.json({ success: true, conversation: conversation.toObject(), status: 'human_active' })
  } catch (err) {
    console.error('reopenSupportConversation error:', err.message)
    res.status(500).json({ error: 'Failed to reopen conversation' })
  }
}

// ────────────────────────────────────────────────────
// POST /api/chat/support/:id/rate
// ────────────────────────────────────────────────────
export async function rateSupportConversation(req, res) {
  try {
    const { id: conversationId } = req.params
    const { rating, feedback = '' } = req.body || {}

    const conversation = await Conversation.findById(conversationId)
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    conversation.rating = Math.min(Math.max(Number(rating) || 5, 1), 5)
    conversation.feedback = feedback
    await conversation.save()

    res.json({ success: true, rating: conversation.rating })
  } catch (err) {
    console.error('rateSupportConversation error:', err.message)
    res.status(500).json({ error: 'Failed to submit rating' })
  }
}

// ────────────────────────────────────────────────────
// GET /api/chat/support/escalations
// ────────────────────────────────────────────────────
export async function getSupportEscalations(req, res) {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ error: 'Staff access required' })
    }

    const { status, priority, role } = req.query
    const filter = {}

    if (status) filter.status = status
    if (priority) filter.priority = priority
    if (role && req.user.role !== 'owner') {
      filter.assignedRole = role
    }

    const escalations = await SupportEscalation.find(filter)
      .sort({ createdAt: -1 })
      .populate('customer', 'name email avatar phone')
      .populate('assignedTo', 'name email role avatar')
      .populate('conversation')
      .limit(100)
      .lean()

    res.json({ escalations })
  } catch (err) {
    console.error('getSupportEscalations error:', err.message)
    res.status(500).json({ error: 'Failed to load escalations' })
  }
}

// ────────────────────────────────────────────────────
// GET /api/chat/support/analytics
// ────────────────────────────────────────────────────
export async function getSupportAnalytics(req, res) {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ error: 'Staff access required' })
    }

    const totalConversations = await Conversation.countDocuments({ isSupport: true })
    const aiActive = await Conversation.countDocuments({ isSupport: true, supportStatus: 'ai_active' })
    const escalated = await Conversation.countDocuments({ isSupport: true, escalated: true })
    const resolved = await Conversation.countDocuments({ isSupport: true, supportStatus: 'resolved' })
    const highPriority = await Conversation.countDocuments({ isSupport: true, priority: { $in: ['high', 'urgent'] } })

    res.json({
      totalConversations,
      aiActive,
      escalated,
      resolved,
      highPriority,
      aiResolutionRate: totalConversations > 0 ? Math.round(((totalConversations - escalated) / totalConversations) * 100) : 100,
    })
  } catch (err) {
    console.error('getSupportAnalytics error:', err.message)
    res.status(500).json({ error: 'Failed to load support analytics' })
  }
}

// ────────────────────────────────────────────────────
// PATCH /api/chat/conversations/:id/read
// ────────────────────────────────────────────────────
export async function markRead(req, res) {
  try {
    const userId = req.user._id
    const { id: conversationId } = req.params

    const conversation = await Conversation.findById(conversationId)
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }
    const isParticipant = conversation.participants.some(
      (p) => String(p) === String(userId)
    )
    if (!isParticipant && !isStaff(req.user)) {
      return res.status(403).json({ error: 'You are not a participant' })
    }

    await Conversation.updateOne(
      { _id: conversationId, 'unreadBy.user': userId },
      { $set: { 'unreadBy.$.count': 0 } }
    )

    await Message.updateMany(
      {
        conversation: conversationId,
        'readBy.user': { $ne: userId },
      },
      {
        $push: { readBy: { user: userId, readAt: new Date() } },
      }
    )

    const io = getIO()
    if (io) {
      io.to(`conv_${conversationId}`).emit('messages_marked_read', {
        conversationId,
        userId: String(userId),
      })
    }

    res.json({ success: true })
  } catch (err) {
    console.error('markRead error:', err.message)
    res.status(500).json({ error: 'Failed to mark as read' })
  }
}

// ────────────────────────────────────────────────────
// DELETE /api/chat/messages/:id
// ────────────────────────────────────────────────────
export async function deleteMessage(req, res) {
  try {
    const userId = req.user._id
    const userRole = req.user.role
    const isOwner = userRole === 'owner'
    const isAdmin = userRole === 'admin'
    const { id: messageId } = req.params
    const mode = req.query.mode || 'for_everyone'

    const message = await Message.findById(messageId)
    if (!message) {
      return res.status(404).json({ error: 'Message not found' })
    }

    const conversation = await Conversation.findById(message.conversation)
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    const isSender = String(message.sender) === String(userId)

    if (mode === 'for_me') {
      if (!message.deletedFor) message.deletedFor = []
      if (!message.deletedFor.includes(userId)) {
        message.deletedFor.push(userId)
        await message.save()
      }
      return res.json({ success: true, mode: 'for_me' })
    }

    if (!isSender && !isOwner && !isAdmin) {
      return res.status(403).json({ error: 'You are not allowed to delete this message for everyone' })
    }

    message.originalText = message.text
    message.deleted = true
    message.deletedAt = new Date()
    message.deletedBy = userId
    message.deletedByName = req.user.name
    message.text = ''
    message.attachments = []
    await message.save()

    const label =
      isOwner
        ? '🚫 Message deleted by Owner'
        : isAdmin
        ? '🚫 Message deleted by Admin'
        : `🚫 Message deleted by ${req.user.name}`

    const io = getIO()
    if (io) {
      io.to(`conv_${message.conversation}`).emit('message_deleted', {
        messageId: String(message._id),
        conversationId: String(message.conversation),
        deletedByName: req.user.name,
        deletedByRole: userRole,
        deletedText: label,
      })
    }

    res.json({ success: true, mode: 'for_everyone' })
  } catch (err) {
    console.error('deleteMessage error:', err.message)
    res.status(500).json({ error: 'Failed to delete message' })
  }
}

// ────────────────────────────────────────────────────
// PATCH /api/chat/conversations/:id/clear
// ────────────────────────────────────────────────────
export async function clearConversation(req, res) {
  try {
    const userId = req.user._id
    const isOwner = req.user.role === 'owner'
    const { id: conversationId } = req.params

    const conversation = await Conversation.findById(conversationId)
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }
    if (!isParticipant(conversation, userId) && !isOwner) {
      return res.status(403).json({ error: 'You are not a participant' })
    }

    if (isOwner) {
      // Store Owner permanently deletes the entire conversation and its messages
      await Message.deleteMany({ conversation: conversationId })
      await SupportEscalation.deleteMany({ conversation: conversationId })
      await Conversation.deleteOne({ _id: conversationId })
      return res.json({ success: true, deletedPermanently: true })
    }

    // Customer or Admin soft-deletes from their personal inbox view
    await Conversation.updateOne(
      { _id: conversationId },
      {
        $addToSet: { deletedFor: userId },
        $push: { clearedBy: { user: userId, clearedAt: new Date() } },
      }
    )

    res.json({ success: true })
  } catch (err) {
    console.error('clearConversation error:', err.message)
    res.status(500).json({ error: 'Failed to clear chat' })
  }
}

// ────────────────────────────────────────────────────
// GET /api/chat/owner/all-conversations
// Staff oversight route (Owner and Admin)
// ────────────────────────────────────────────────────
export async function getOwnerAllConversations(req, res) {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ error: 'Staff access required' })
    }

    cleanupExpiredTemporaryConversations().catch(() => {})

    const { status, isSupport } = req.query
    const filter = {
      deletedFor: { $ne: req.user._id },
      $or: [
        { isTemporary: { $ne: true } },
        { savedPermanently: true },
        { expiresAt: { $gt: new Date() } },
        { expiresAt: null },
      ],
    }

    if (status) {
      filter.supportStatus = status
    }
    if (typeof isSupport !== 'undefined') {
      filter.isSupport = isSupport === 'true'
    }

    const conversations = await Conversation.find(filter)
      .sort({ updatedAt: -1 })
      .populate('participants', 'name email avatar role status phone')
      .populate('assignedUser', 'name email avatar role')
      .lean()

    res.json({ conversations })
  } catch (err) {
    console.error('getOwnerAllConversations error:', err.message)
    res.status(500).json({ error: 'Failed to load store conversations' })
  }
}

// ────────────────────────────────────────────────────
// POST /api/chat/support/:id/close
// Close / archive ticket permanently
// ────────────────────────────────────────────────────
export async function closeSupportConversation(req, res) {
  try {
    const { id: conversationId } = req.params
    const { closeNote = '' } = req.body || {}
    const user = req.user

    const conversation = await Conversation.findById(conversationId)
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    if (!isStaff(user) && !isParticipant(conversation, user._id)) {
      return res.status(403).json({ error: 'Staff access required' })
    }

    conversation.supportStatus = 'closed'
    conversation.resolvedAt = new Date()
    conversation.resolvedBy = user._id
    conversation.resolvedByName = user.name
    conversation.resolutionNote = closeNote || `Closed by ${user.name} (${user.role})`
    await conversation.save()

    const existingEsc = await SupportEscalation.findOne({ conversation: conversationId })
    if (existingEsc) {
      existingEsc.status = 'resolved'
      existingEsc.resolvedAt = new Date()
      existingEsc.resolvedBy = user._id
      existingEsc.resolutionNote = `Closed by ${user.name}`
      await existingEsc.save()
    }

    const systemMsg = await Message.create({
      conversation: conversationId,
      sender: user._id,
      senderName: user.name,
      senderRole: user.role,
      type: 'system',
      text: `🔒 Support ticket closed by ${user.name} (${user.role}). ${closeNote ? `Note: ${closeNote}` : ''}`,
    })

    const io = getIO()
    if (io) {
      io.to(`conv_${conversationId}`).emit('support_status_changed', {
        conversationId,
        supportStatus: 'closed',
        closedBy: user.name,
      })
      io.to(`conv_${conversationId}`).emit('receive_message', systemMsg.toObject())
      io.to('staff_room').emit('conversation_updated', conversation.toObject())
    }

    res.json({ success: true, conversation: conversation.toObject(), status: 'closed' })
  } catch (err) {
    console.error('closeSupportConversation error:', err.message)
    res.status(500).json({ error: 'Failed to close support ticket' })
  }
}

// ────────────────────────────────────────────────────
// PATCH /api/chat/conversations/:id/retention
// Update temporary vs permanent save status
// ────────────────────────────────────────────────────
export async function updateConversationRetention(req, res) {
  try {
    const { id: conversationId } = req.params
    const { action = 'make_temporary', days = 3 } = req.body || {}
    const user = req.user

    const conversation = await Conversation.findById(conversationId)
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    if (!isStaff(user) && !isParticipant(conversation, user._id)) {
      return res.status(403).json({ error: 'Permission denied' })
    }

    if (action === 'discard') {
      await Message.deleteMany({ conversation: conversationId })
      await Conversation.deleteOne({ _id: conversationId })
      return res.json({ success: true, discarded: true })
    }

    if (action === 'save_permanent') {
      conversation.savedPermanently = true
      conversation.isTemporary = false
      conversation.expiresAt = null
      await conversation.save()
      return res.json({
        success: true,
        conversation: conversation.toObject(),
        savedPermanently: true,
        isTemporary: false,
      })
    }

    // Default make temporary with specified days (default: 3 days)
    const retentionDays = Math.max(1, Number(days) || 3)
    conversation.savedPermanently = false
    conversation.isTemporary = true
    conversation.expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000)
    await conversation.save()

    res.json({
      success: true,
      conversation: conversation.toObject(),
      isTemporary: true,
      expiresAt: conversation.expiresAt,
    })
  } catch (err) {
    console.error('updateConversationRetention error:', err.message)
    res.status(500).json({ error: 'Failed to update conversation retention' })
  }
}

// ────────────────────────────────────────────────────
// GET /api/chat/conversations/search
// ────────────────────────────────────────────────────
export async function searchConversations(req, res) {
  try {
    const userId = req.user._id
    const { q } = req.query

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' })
    }

    const matchingUsers = await User.find({
      name: { $regex: q.trim(), $options: 'i' },
    })
      .select('_id')
      .limit(20)
      .lean()

    const matchingIds = matchingUsers.map((u) => u._id)

    const conversations = await Conversation.find({
      participants: { $all: [userId], $in: matchingIds },
      isArchived: false,
    })
      .sort({ updatedAt: -1 })
      .populate('participants', 'name email avatar role status phone')
      .populate('assignedUser', 'name email avatar role')
      .lean()

    res.json({ conversations })
  } catch (err) {
    console.error('searchConversations error:', err.message)
    res.status(500).json({ error: 'Search failed' })
  }
}

// ────────────────────────────────────────────────────
// GET /api/chat/online-users
// ────────────────────────────────────────────────────
export async function getOnlineUsers(req, res) {
  try {
    const { getOnlineUserIds } = await import('../socket.js')
    const onlineIds = getOnlineUserIds ? getOnlineUserIds() : []
    res.json({ onlineUsers: onlineIds })
  } catch (err) {
    console.error('getOnlineUsers error:', err.message)
    res.json({ onlineUsers: [] })
  }
}

// ────────────────────────────────────────────────────
// GET /api/chat/staff-users
// ────────────────────────────────────────────────────
export async function getStaffUsers(req, res) {
  try {
    const staff = await User.find({
      role: { $in: ['admin', 'owner'] },
      status: 'active',
    })
      .select('name email avatar role')
      .lean()

    res.json({ staff })
  } catch (err) {
    console.error('getStaffUsers error:', err.message)
    res.status(500).json({ error: 'Failed to load staff users' })
  }
}

// ────────────────────────────────────────────────────
// GET /api/chat/customer-users
// ────────────────────────────────────────────────────
export async function getCustomerUsers(req, res) {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Staff access required' })
    }
    const customers = await User.find({
      role: 'user',
      status: 'active',
    })
      .select('name email avatar role phone')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()

    res.json({ customers })
  } catch (err) {
    console.error('getCustomerUsers error:', err.message)
    res.status(500).json({ error: 'Failed to load customers' })
  }
}
