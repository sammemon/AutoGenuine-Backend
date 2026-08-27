import Conversation from '../models/Conversation.js'
import Message from '../models/Message.js'
import User from '../models/User.js'
import SupportEscalation from '../models/SupportEscalation.js'
import Notification from '../models/Notification.js'
import { getIO } from '../socket.js'
import { createNotification } from './notificationService.js'

/**
 * Executes a full human escalation workflow
 */
export async function executeEscalation({ conversationId, escalation = {}, customerId, customerName, customerEmail }) {
  try {
    const {
      reason = 'Issue requires human assistance',
      target = 'admin',
      category = 'general_support',
      priority = 'high',
      customerSummary = '',
      recommendedAction = '',
    } = escalation

    const conversation = await Conversation.findById(conversationId)
    if (!conversation) throw new Error('Conversation not found')

    // Find staff members to add as participants so they can view and message
    const staffQuery = target === 'owner' ? { role: 'owner' } : { role: { $in: ['admin', 'owner'] } }
    const staffUsers = await User.find(staffQuery).select('_id name role email').lean()
    const staffIds = staffUsers.map((s) => s._id)

    // Add staff to conversation participants without duplicates
    for (const sid of staffIds) {
      if (!conversation.participants.some((p) => String(p) === String(sid))) {
        conversation.participants.push(sid)
      }
    }

    const assignedRole = target === 'owner' ? 'owner' : 'admin'
    const supportStatus = target === 'owner' ? 'assigned_to_store_owner' : 'assigned_to_admin'

    conversation.isSupport = true
    conversation.escalated = true
    conversation.escalationReason = reason
    conversation.escalationTarget = target
    conversation.assignedRole = assignedRole
    conversation.supportStatus = supportStatus
    conversation.priority = priority
    conversation.supportCategory = category
    conversation.aiSummary = customerSummary
    conversation.recommendedAction = recommendedAction

    await conversation.save()

    // 1. Create SupportEscalation Record for audit and dashboard filtering
    const escalationDoc = await SupportEscalation.create({
      conversation: conversation._id,
      customer: customerId || conversation.createdBy,
      customerName: customerName || 'Customer',
      customerEmail: customerEmail || '',
      assignedRole,
      reason,
      category,
      priority,
      aiSummary: customerSummary,
      recommendedAction,
      orderRef: conversation.orderRef || '',
      productSlug: conversation.productSlug || '',
      status: 'pending',
    })

    // 2. Create System Message in Chat
    const systemText = `🚨 Support Escalated to ${target === 'owner' ? 'Store Owner' : 'Admin Support'}\n` +
      `Reason: ${reason}\n` +
      `Priority: ${priority.toUpperCase()}\n` +
      `${customerSummary ? `Summary: ${customerSummary}` : ''}`

    const systemMessage = await Message.create({
      conversation: conversation._id,
      sender: null,
      senderName: 'AutoGenuine System',
      senderRole: 'system',
      type: 'system',
      text: systemText,
      escalationData: {
        reason,
        target,
        category,
        priority,
        aiSummary: customerSummary,
        recommendedAction,
      },
      readBy: [{ user: customerId, readAt: new Date() }],
    })

    // Update conversation lastMessage
    conversation.lastMessage = {
      _id: systemMessage._id,
      text: `🚨 Escalated to ${target === 'owner' ? 'Store Owner' : 'Admin'}: ${reason}`.substring(0, 100),
      senderName: 'System',
      type: 'system',
      createdAt: systemMessage.createdAt,
    }
    await conversation.save()

    // 3. Centralized Notification Service (Socket if staff online, Email if offline, persistent DB)
    const notifResult = await createNotification({
      type: 'AI_ESCALATION',
      title: `🔔 Support Escalation: ${category.replace(/_/g, ' ').toUpperCase()} (${priority.toUpperCase()})`,
      message: `${customerName || 'Customer'}: ${reason}`,
      recipientRole: target === 'owner' ? 'owner' : 'staff',
      conversationId: conversation._id,
      ticketId: String(escalationDoc._id),
      orderRef: conversation.orderRef || '',
      customerName: customerName || 'Customer',
      customerEmail: customerEmail || '',
      priority,
      category,
      aiSummary: customerSummary,
      metadata: {
        reason,
        target,
        recommendedAction,
      },
    })
    const notification = notifResult.notification

    // 4. Socket.IO Real-time Events
    const io = getIO()
    if (io) {
      // Broadcast to Staff Room (Admins and Store Owner)
      io.to('staff_room').emit('support_escalation_created', {
        escalation: escalationDoc.toObject(),
        conversation: conversation.toObject(),
        message: systemMessage.toObject(),
        notification: notification.toObject(),
      })
      io.to('staff_room').emit('notification_created', notification.toObject())

      // Broadcast to Conversation Room
      io.to(`conv_${conversation._id}`).emit('conversation_escalated', {
        conversationId: String(conversation._id),
        escalation: escalationDoc.toObject(),
        conversation: conversation.toObject(),
      })
      io.to(`conv_${conversation._id}`).emit('receive_message', systemMessage.toObject())

      // Refresh participant conversation lists
      for (const pid of conversation.participants) {
        io.to(`user_${pid}`).emit('conversation_updated', {
          ...conversation.toObject(),
          myUnread: 0,
        })
      }
    }

    return {
      escalation: escalationDoc,
      systemMessage,
      conversation,
    }
  } catch (err) {
    console.error('✗ [escalationService] Failed to execute escalation:', err.message)
    throw err
  }
}
