import { Server } from 'socket.io'
import jwt from 'jsonwebtoken'
import User from './models/User.js'
import Notification from './models/Notification.js'
import Conversation from './models/Conversation.js'
import Message from './models/Message.js'
import UserBlock from './models/UserBlock.js'
import { processCustomerMessageWithAI } from './services/geminiService.js'
import { executeEscalation } from './services/escalationService.js'
import { createNotification } from './services/notificationService.js'

let io = null

// Track online users: Map<userId, Set<socketId>>
const onlineUsers = new Map()
const MESSAGE_MAX_LENGTH = 4000

function isConversationParticipant(conversation, userId) {
  return conversation.participants.some((p) => String(p) === String(userId))
}

export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, true),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      credentials: true,
    },
    pingTimeout: 30000,
    pingInterval: 25000,
  })

  // Socket authentication middleware (allows both staff, logged-in customers, and guest tracking)
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '')
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-key-change-in-prod')
        const userId = decoded.sub || decoded.userId || decoded.id || decoded._id
        if (userId) {
          const user = await User.findById(userId).select('-passwordHash -password').lean()
          if (user) {
            socket.user = user
          }
        }
      }
      next()
    } catch (err) {
      // Allow connection even without token for live customer order tracking
      next()
    }
  })

  io.on('connection', (socket) => {
    const user = socket.user

    if (user) {
      const uid = String(user._id)
      socket.join(`user_${uid}`)

      // Track online presence
      if (!onlineUsers.has(uid)) {
        onlineUsers.set(uid, new Set())
        // First tab — broadcast online status
        io.emit('user_online', { userId: uid })
      }
      onlineUsers.get(uid).add(socket.id)

      if (user.role === 'admin' || user.role === 'owner') {
        socket.join('staff_room')
        console.log(`🔌 [Socket.io] Staff connected: ${user.name} (${user.role}) - Socket ID: ${socket.id}`)
      } else {
        console.log(`🔌 [Socket.io] Customer connected: ${user.name} - Socket ID: ${socket.id}`)
      }
    }

    // ── Chat Events ─────────────────────────────────────

    // Join a conversation room for real-time updates
    socket.on('join_conversation', async ({ conversationId }) => {
      if (!user || !conversationId) return
      try {
        const conv = await Conversation.findById(conversationId).lean()
        if (!conv) return
        const isParticipant = conv.participants.some(
          (p) => String(p) === String(user._id)
        )
        // Allow admins/owners to join any support conversation
        const isStaffMember = user.role === 'admin' || user.role === 'owner'
        if (!isParticipant && !isStaffMember) return

        socket.join(`conv_${conversationId}`)
      } catch (err) {
        console.error('join_conversation error:', err.message)
      }
    })

    // Leave a conversation room
    socket.on('leave_conversation', ({ conversationId }) => {
      if (!conversationId) return
      socket.leave(`conv_${conversationId}`)
    })

    // Typing indicators (ephemeral, no DB)
    socket.on('typing_start', ({ conversationId }) => {
      if (!user || !conversationId) return
      Conversation.findById(conversationId).lean().then((conv) => {
        if (!conv || (!isConversationParticipant(conv, user._id) && user.role === 'user')) return
        socket.to(`conv_${conversationId}`).emit('typing_start', {
          conversationId,
          userId: String(user._id),
          userName: user.name,
          userRole: user.role,
        })
      }).catch((err) => console.error('typing_start error:', err.message))
    })

    socket.on('typing_stop', ({ conversationId }) => {
      if (!user || !conversationId) return
      Conversation.findById(conversationId).lean().then((conv) => {
        if (!conv || (!isConversationParticipant(conv, user._id) && user.role === 'user')) return
        socket.to(`conv_${conversationId}`).emit('typing_stop', {
          conversationId,
          userId: String(user._id),
        })
      }).catch((err) => console.error('typing_stop error:', err.message))
    })

    // Socket-based message sending
    socket.on('send_message', async ({ conversationId, text, type = 'text', tempId, linkedPartSlug = '', linkedOrderRef = '', attachments = [] } = {}, ack) => {
      try {
        if (!user) throw new Error('Not authenticated')
        if (!conversationId) throw new Error('conversationId is required')

        const cleanText = typeof text === 'string' ? text.trim().replace(/\s+\n/g, '\n') : ''
        const validAttachments = Array.isArray(attachments) ? attachments.filter((a) => a && a.url) : []

        if (!cleanText && validAttachments.length === 0) {
          throw new Error('Message text or attachment is required')
        }
        if (cleanText.length > MESSAGE_MAX_LENGTH) throw new Error(`Message must be ${MESSAGE_MAX_LENGTH} characters or fewer`)
        if (!['text', 'image', 'file', 'product', 'order'].includes(type)) throw new Error('Unsupported message type')

        let conversation = await Conversation.findById(conversationId)
        if (!conversation) throw new Error('Conversation not found')

        // If staff, auto join participants
        if ((user.role === 'admin' || user.role === 'owner') && !isConversationParticipant(conversation, user._id)) {
          conversation.participants.push(user._id)
          if (conversation.supportStatus === 'escalation_pending' || conversation.supportStatus === 'ai_active') {
            conversation.supportStatus = 'human_active'
            conversation.assignedUser = user._id
            conversation.assignedRole = user.role
          }
          await conversation.save()
        } else if (!isConversationParticipant(conversation, user._id)) {
          throw new Error('You are not a participant')
        }

        // Prevent customers from sending messages on closed or resolved tickets
        if (user.role === 'user' && ['closed', 'resolved'].includes(conversation.supportStatus)) {
          throw new Error('This support ticket is closed and resolved. Submit a reopen request to send messages.')
        }

        const otherParticipants = conversation.participants.filter((p) => String(p) !== String(user._id))
        const blockExists = await UserBlock.findOne({
          $or: otherParticipants.map((p) => ({ blocker: p, blocked: user._id })),
        })
        if (blockExists) throw new Error('You cannot send messages in this conversation')

        const messageType = validAttachments.length > 0 && type === 'text' ? 'image' : type

        const message = await Message.create({
          conversation: conversationId,
          sender: user._id,
          senderName: user.name,
          senderRole: user.role,
          type: messageType,
          text: cleanText,
          attachments: validAttachments,
          linkedPartSlug: linkedPartSlug || conversation.productSlug || '',
          linkedOrderRef: linkedOrderRef || conversation.orderRef || '',
          readBy: [{ user: user._id, readAt: new Date() }],
        })

        const previewText = cleanText || (validAttachments.length > 0 ? '📷 Image' : (linkedPartSlug ? '📦 Part Inquiry' : (linkedOrderRef ? '🧾 Order Inquiry' : 'New message')))

        const updateOps = {
          lastMessage: {
            _id: message._id,
            text: previewText.substring(0, 100),
            sender: user._id,
            senderName: user.name,
            type: message.type,
            createdAt: message.createdAt,
          },
        }

        for (const pid of conversation.participants) {
          if (String(pid) === String(user._id)) continue
          const result = await Conversation.updateOne(
            { _id: conversationId, 'unreadBy.user': pid },
            { $inc: { 'unreadBy.$.count': 1 }, $set: updateOps }
          )
          if (result.matchedCount === 0) {
            await Conversation.updateOne(
              { _id: conversationId },
              { $push: { unreadBy: { user: pid, count: 1 } }, $set: updateOps }
            )
          }
        }

        await Conversation.updateOne({ _id: conversationId }, { $set: updateOps })

        const populatedMessage = await Message.findById(message._id)
          .populate('sender', 'name avatar role')
          .lean()
        io.to(`conv_${conversationId}`).emit('receive_message', { ...populatedMessage, tempId })

        const updatedConv = await Conversation.findById(conversationId)
          .populate('participants', 'name email avatar role status')
          .populate('assignedUser', 'name email avatar role')
          .lean()
        for (const pid of conversation.participants) {
          const entry = (updatedConv.unreadBy || []).find((u) => String(u.user) === String(pid))
          io.to(`user_${pid}`).emit('conversation_updated', {
            ...updatedConv,
            myUnread: entry?.count || 0,
          })
        }

        if (typeof ack === 'function') ack({ ok: true, message: populatedMessage })

        // Trigger Notification Service if customer sends a message to staff
        if (user.role === 'user' && cleanText) {
          createNotification({
            type: 'NEW_MESSAGE',
            title: `💬 New Message from ${user.name}`,
            message: cleanText.substring(0, 100),
            recipientRole: 'staff',
            userId: user._id,
            conversationId,
            orderRef: conversation.orderRef || '',
            customerName: user.name,
            customerEmail: user.email,
            metadata: {
              senderName: user.name,
              senderEmail: user.email,
              text: cleanText,
              orderRef: conversation.orderRef || '',
            },
          })
        }

        // Check if any human staff members are currently online in staff_room
        const staffRoomSize = io.sockets.adapter.rooms.get('staff_room')?.size || 0
        const isStaffActiveOnline = staffRoomSize > 0

        // Trigger AI support if:
        // 1. conversation is in ai_active mode
        // 2. OR staff/owner is offline (AI acts as autonomous store manager)
        // 3. OR ticket is pending escalation but no human staff is online
        const shouldAITakeOver =
          conversation.isSupport &&
          user.role === 'user' &&
          cleanText &&
          (conversation.supportStatus === 'ai_active' || !isStaffActiveOnline || conversation.supportStatus === 'escalation_pending')

        if (shouldAITakeOver) {
          (async () => {
            try {
              io.to(`conv_${conversationId}`).emit('ai_typing', { conversationId: String(conversationId), isTyping: true })

              const aiResult = await processCustomerMessageWithAI({
                conversation,
                user,
                customerMessageText: cleanText,
                isStaffOffline: !isStaffActiveOnline,
              })

              io.to(`conv_${conversationId}`).emit('ai_typing', { conversationId: String(conversationId), isTyping: false })

              const aiMessage = await Message.create({
                conversation: conversationId,
                sender: null,
                senderName: isStaffActiveOnline ? 'AutoGenuine AI' : 'AI Acting Store Manager',
                senderRole: 'ai',
                isAI: true,
                type: 'text',
                text: aiResult.aiText,
                aiMetadata: {
                  toolsUsed: aiResult.toolsUsed,
                  escalated: aiResult.shouldEscalate,
                  reason: aiResult.escalation?.reason,
                  recommendedAction: aiResult.escalation?.recommendedAction,
                  actingAsStaff: !isStaffActiveOnline,
                },
                readBy: [{ user: user._id, readAt: new Date() }],
              })

              const aiUpdateOps = {
                lastMessage: {
                  _id: aiMessage._id,
                  text: aiResult.aiText.substring(0, 100),
                  senderName: isStaffActiveOnline ? 'AutoGenuine AI' : 'AI Acting Store Manager',
                  type: 'text',
                  createdAt: aiMessage.createdAt,
                },
              }
              await Conversation.updateOne({ _id: conversationId }, { $set: aiUpdateOps })

              io.to(`conv_${conversationId}`).emit('receive_message', aiMessage.toObject())

              if (aiResult.shouldEscalate && aiResult.escalation && isStaffActiveOnline) {
                await executeEscalation({
                  conversationId,
                  escalation: aiResult.escalation,
                  customerId: user._id,
                  customerName: user.name,
                  customerEmail: user.email,
                })
              }
            } catch (err) {
              console.error('AI chat handler error:', err)
              io.to(`conv_${conversationId}`).emit('ai_typing', { conversationId: String(conversationId), isTyping: false })
            }
          })()
        }
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: err.message })
        socket.emit('message_error', { conversationId, tempId, error: err.message })
      }
    })

    // Real-time message read receipt
    socket.on('message_read', async ({ conversationId }) => {
      if (!user || !conversationId) return
      try {
        const conv = await Conversation.findById(conversationId).lean()
        if (!conv) return
        if (!isConversationParticipant(conv, user._id) && user.role === 'user') return

        // Reset unread count for this user
        await Conversation.updateOne(
          { _id: conversationId, 'unreadBy.user': user._id },
          { $set: { 'unreadBy.$.count': 0 } }
        )

        // Mark all messages in conversation as read by this user
        await Message.updateMany(
          {
            conversation: conversationId,
            'readBy.user': { $ne: user._id },
          },
          {
            $push: { readBy: { user: user._id, readAt: new Date() } },
          }
        )

        // Broadcast read receipt
        socket.to(`conv_${conversationId}`).emit('messages_marked_read', {
          conversationId,
          userId: String(user._id),
        })
      } catch (err) {
        console.error('message_read socket error:', err.message)
      }
    })

    // ── Disconnect ──────────────────────────────────────

    socket.on('disconnect', () => {
      if (user) {
        const uid = String(user._id)
        const sockets = onlineUsers.get(uid)
        if (sockets) {
          sockets.delete(socket.id)
          if (sockets.size === 0) {
            onlineUsers.delete(uid)
            // Last tab closed — broadcast offline
            io.emit('user_offline', { userId: uid })
          }
        }
      }
    })
  })

  return io
}

export function getIO() {
  return io
}

// Returns array of online user ID strings
export function getOnlineUserIds() {
  return Array.from(onlineUsers.keys())
}

/**
 * Broadcast real-time event to connected staff and all clients
 * and persist the notification in MongoDB.
 */
export async function emitToStaff(eventName, payload = {}) {
  try {
    if (io) {
      // 1. Send to staff room for admin dashboard
      io.to('staff_room').emit(eventName, payload)

      // 2. Broadcast order events to all connected clients so MyOrders and TrackOrder update live instantly
      if (eventName === 'order_status_updated' || eventName === 'new_order') {
        io.emit(eventName, payload)
      }
    }

    // Persist notification in database for history if it's a new order or status change
    if (eventName === 'new_order') {
      await Notification.create({
        type: 'NEW_ORDER',
        title: `New Order Placed (#${payload.orderRef || String(payload._id || '').slice(-6).toUpperCase()})`,
        message: `New order of Rs ${payload.total?.toLocaleString() || '0'} placed by ${payload.customerName || 'Customer'}`,
        orderId: payload._id,
        orderRef: payload.orderRef || String(payload._id || '').slice(-6).toUpperCase(),
        customerName: payload.customerName,
        total: payload.total,
        paymentMethod: payload.paymentMethod,
        read: false,
      })
    } else if (eventName === 'order_status_updated') {
      await Notification.create({
        type: 'ORDER_STATUS_UPDATED',
        title: `Order Status Updated (#${payload.orderRef || String(payload._id || '').slice(-6).toUpperCase()})`,
        message: `Order #${payload.orderRef || String(payload._id || '').slice(-6).toUpperCase()} status changed to ${payload.status?.toUpperCase()}`,
        orderId: payload._id,
        orderRef: payload.orderRef || String(payload._id || '').slice(-6).toUpperCase(),
        customerName: payload.customerName,
        total: payload.total,
        read: false,
      })
    }
  } catch (err) {
    console.error('Failed to emit/save notification:', err.message)
  }
}
