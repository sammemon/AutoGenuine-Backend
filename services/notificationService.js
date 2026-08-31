import Notification from '../models/Notification.js'
import User from '../models/User.js'
import { getIO, getOnlineUserIds } from '../socket.js'
import {
  sendEmail,
  buildNewOrderEmail,
  buildCustomerOrderConfirmationEmail,
  buildAbandonedCartEmail,
  buildNewMessageEmail,
  buildContactMessageEmail,
  buildAIEscalationEmail,
  buildPaymentSuccessEmail,
  buildPaymentFailedEmail,
  buildOrderStatusEmail,
} from './emailService.js'

/**
 * Creates a persistent database notification, checks real-time online presence,
 * dispatches Socket.IO event if online, or sends an SMTP email fallback if offline.
 *
 * @param {Object} options
 * @param {String} options.type - NEW_ORDER, NEW_MESSAGE, NEW_SUPPORT_TICKET, NEW_CONTACT_MESSAGE, AI_ESCALATION, PAYMENT_SUCCESS, PAYMENT_FAILED, ORDER_STATUS_CHANGED, DELIVERY_STATUS_CHANGED, SYSTEM_ALERT
 * @param {String} options.title - Short header text
 * @param {String} options.message - Descriptive body text
 * @param {String} [options.recipient] - Specific target user ObjectId string
 * @param {String} [options.recipientRole] - 'user' | 'admin' | 'owner' | 'staff' | 'all' (default: 'staff')
 * @param {String} [options.userId] - Customer involved
 * @param {String} [options.orderId] - Order ObjectId
 * @param {String} [options.orderRef] - Order Reference code
 * @param {String} [options.conversationId] - Conversation ObjectId
 * @param {String} [options.ticketId] - Ticket / Escalation ID
 * @param {String} [options.customerName] - Customer display name
 * @param {String} [options.customerEmail] - Customer email address
 * @param {Number} [options.total] - Monetary amount if applicable
 * @param {String} [options.paymentMethod] - Payment method
 * @param {String} [options.priority] - 'low' | 'medium' | 'high' | 'urgent'
 * @param {String} [options.category] - Support category
 * @param {String} [options.aiSummary] - AI diagnostic summary if escalated
 * @param {Object} [options.metadata] - Custom metadata
 */
export async function createNotification(options = {}) {
  try {
    const {
      type = 'GENERAL',
      title = 'System Notification',
      message = '',
      recipient = null,
      recipientRole = 'staff',
      userId = null,
      orderId = null,
      orderRef = '',
      conversationId = null,
      ticketId = '',
      customerName = '',
      customerEmail = '',
      total = 0,
      paymentMethod = '',
      priority = 'medium',
      category = 'general_support',
      aiSummary = '',
      metadata = {},
    } = options

    // 1. Idempotency & Duplicate Protection Check (within last 3 seconds for identical type, recipientRole & orderId/conversationId)
    if (orderId || conversationId) {
      const existing = await Notification.findOne({
        type,
        recipientRole,
        ...(orderId ? { orderId } : {}),
        ...(conversationId ? { conversationId } : {}),
        createdAt: { $gte: new Date(Date.now() - 3000) },
      }).lean()

      if (existing) {
        console.log(`ℹ️ [notificationService] Duplicate notification suppressed for type ${type} (${orderRef || orderId || conversationId})`)
        return { success: true, duplicated: true, notification: existing }
      }
    }

    // 2. Create Persistent Database Notification
    const notificationDoc = await Notification.create({
      type,
      title,
      message,
      recipient: recipient || null,
      recipientRole,
      userId: userId || null,
      orderId: orderId || null,
      orderRef: orderRef || '',
      conversationId: conversationId || null,
      ticketId: ticketId || '',
      customerName: customerName || '',
      customerEmail: customerEmail || '',
      total: total || 0,
      paymentMethod: paymentMethod || '',
      priority,
      category,
      aiSummary: aiSummary || '',
      metadata: metadata || {},
      read: false,
    })

    // 3. Resolve Target Recipient Users & Email Addresses
    let targetUsers = []
    const processedEmails = new Set()

    if (recipient) {
      const user = await User.findById(recipient).select('_id name email role privacyPreferences').lean()
      if (user && user.email) {
        targetUsers.push(user)
        processedEmails.add(user.email.toLowerCase().trim())
      }
    }

    if (recipientRole === 'staff' || recipientRole === 'admin' || recipientRole === 'owner') {
      let roleFilter = { role: { $in: ['admin', 'owner'] } }
      if (recipientRole === 'admin') roleFilter = { role: 'admin' }
      if (recipientRole === 'owner') roleFilter = { role: 'owner' }

      const dbStaff = await User.find({ ...roleFilter, status: 'active' })
        .select('_id name email role privacyPreferences')
        .lean()

      for (const u of dbStaff) {
        if (!u.email) continue
        let emailClean = u.email.toLowerCase().trim()

        // Remap legacy dummy staff emails
        if (emailClean === 'owner@autogenuine.com' || emailClean === 'owner@example.com') {
          emailClean = (process.env.OWNER_EMAIL || 'OwnerAutogenuine@gmail.com').toLowerCase().trim()
        } else if (emailClean === 'admin@autogenuine.com' || emailClean === 'admin@example.com') {
          emailClean = (process.env.ADMIN_EMAIL || 'adminautogenuine@gmail.com').toLowerCase().trim()
        }

        if (!processedEmails.has(emailClean)) {
          targetUsers.push({
            ...u,
            email: emailClean,
          })
          processedEmails.add(emailClean)
        }
      }

      // Guarantee official staff email recipients ALWAYS receive email notifications
      const officialStaffEmails = [
        process.env.OWNER_EMAIL,
        process.env.ADMIN_EMAIL,
      ].filter(Boolean)

      for (const em of officialStaffEmails) {
        const clean = em.toLowerCase().trim()
        if (!processedEmails.has(clean)) {
          targetUsers.push({
            _id: `staff_${clean}`,
            name: clean.includes('owner') ? 'Store Owner' : 'Store Admin',
            email: clean,
            role: clean.includes('owner') ? 'owner' : 'admin',
          })
          processedEmails.add(clean)
        }
      }
    } else if (recipientRole === 'user' || recipientRole === 'all') {
      if (userId) {
        const user = await User.findById(userId).select('_id name email role privacyPreferences').lean()
        if (user && user.email && !processedEmails.has(user.email.toLowerCase().trim())) {
          targetUsers.push(user)
          processedEmails.add(user.email.toLowerCase().trim())
        }
      }
      if (customerEmail && !processedEmails.has(customerEmail.toLowerCase().trim())) {
        targetUsers.push({
          _id: `customer_${customerEmail.toLowerCase().trim()}`,
          name: customerName || 'Valued Customer',
          email: customerEmail.toLowerCase().trim(),
          role: 'user',
        })
        processedEmails.add(customerEmail.toLowerCase().trim())
      }
    }

    // 4. Presence Checking & Channel Dispatch
    const onlineIds = new Set(getOnlineUserIds().map(String))
    const io = getIO()

    let socketDeliveredCount = 0
    let emailSentCount = 0
    let lastEmailError = ''

    for (const targetUser of targetUsers) {
      const uidStr = String(targetUser._id)
      const isOnline = onlineIds.has(uidStr)

      // 1. Deliver instant Socket.IO real-time notification if user is currently online
      if (isOnline && io) {
        io.to(`user_${uidStr}`).emit('notification_created', notificationDoc.toObject())
        socketDeliveredCount++
      }

      // 2. Dispatch SMTP Email Notification (Always for staff members OR important events, regardless of online status)
      const isStaffUser = targetUser.role === 'owner' || targetUser.role === 'admin'
      const isImportantEvent = [
        'NEW_ORDER',
        'ORDER_STATUS_CHANGED',
        'ORDER_STATUS_UPDATED',
        'DELIVERY_STATUS_CHANGED',
        'PAYMENT_SUCCESS',
        'PAYMENT_FAILED',
        'AI_ESCALATION',
        'SUPPORT_ESCALATION',
        'NEW_SUPPORT_TICKET',
        'NEW_CONTACT_MESSAGE',
        'NEW_MESSAGE',
        'SUPPORT_MESSAGE',
      ].includes(type)

      const shouldSendEmail = (isStaffUser || !isOnline || isImportantEvent) && targetUser.privacyPreferences?.emailUpdates !== false && targetUser.email

      if (shouldSendEmail) {
        const emailPayload = buildEmailPayloadForType({
          type,
          title,
          message,
          targetUser,
          orderId,
          orderRef,
          customerName,
          customerEmail,
          total,
          paymentMethod,
          priority,
          category,
          aiSummary,
          metadata,
        })

        if (emailPayload) {
          const emailResult = await sendEmail({
            to: targetUser.email,
            subject: emailPayload.subject,
            html: emailPayload.html,
          })

          if (emailResult.success) {
            emailSentCount++
          } else {
            lastEmailError = emailResult.error || emailResult.reason || 'Email dispatch failed'
          }
        }
      }
    }

    // 3. Send order confirmation email directly to the purchasing customer
    if (type === 'NEW_ORDER' && customerEmail) {
      const custEmailPayload = buildCustomerOrderConfirmationEmail({
        orderRef,
        customerName: customerName || metadata.customerName,
        total: total || metadata.total,
        items: metadata.items || [],
        paymentMethod: paymentMethod || metadata.paymentMethod,
        order: { customerEmail, customerPhone: metadata.customerPhone, city: metadata.city, shippingAddress: metadata.shippingAddress },
      })

      if (custEmailPayload) {
        const custEmailResult = await sendEmail({
          to: customerEmail,
          subject: custEmailPayload.subject,
          html: custEmailPayload.html,
        })

        if (custEmailResult.success) {
          emailSentCount++
        }
      }
    }

    // Also broadcast to staff_room for dashboard header bell counter if staff-targeted
    if (io && (recipientRole === 'staff' || recipientRole === 'admin' || recipientRole === 'owner')) {
      io.to('staff_room').emit('notification_created', notificationDoc.toObject())
    }

    // 5. Update Notification Delivery Status in DB
    if (emailSentCount > 0) {
      notificationDoc.emailSent = true
      notificationDoc.emailSentAt = new Date()
    } else if (lastEmailError) {
      notificationDoc.emailFailed = true
      notificationDoc.emailError = lastEmailError
    }
    await notificationDoc.save()

    console.log(
      `🔔 [notificationService] Notification Created [${type}] | Online Socket Deliveries: ${socketDeliveredCount} | Offline Emails Sent: ${emailSentCount}`
    )

    return {
      success: true,
      notification: notificationDoc,
      socketDeliveredCount,
      emailSentCount,
    }
  } catch (err) {
    console.error('❌ [notificationService] Failure notice (business operation unblocked):', err.message)
    return {
      success: false,
      error: err.message,
    }
  }
}

/**
 * Builds appropriate HTML email subject and content based on notification type.
 */
function buildEmailPayloadForType({
  type,
  title,
  message,
  targetUser,
  orderRef,
  customerName,
  customerEmail,
  total,
  paymentMethod,
  priority,
  category,
  aiSummary,
  metadata = {},
}) {
  switch (type) {
    case 'NEW_ORDER':
      return buildNewOrderEmail({
        orderRef,
        customerName: customerName || metadata.customerName,
        total: total || metadata.total,
        items: metadata.items || [],
        paymentMethod: paymentMethod || metadata.paymentMethod,
        order: { customerEmail: customerEmail || metadata.customerEmail, customerPhone: metadata.customerPhone, city: metadata.city, shippingAddress: metadata.shippingAddress },
      })

    case 'NEW_MESSAGE':
    case 'SUPPORT_MESSAGE':
      return buildNewMessageEmail({
        senderName: customerName || metadata.senderName || 'Customer',
        senderEmail: customerEmail || metadata.senderEmail || '',
        messageText: message || metadata.text || 'New message received',
        orderRef: orderRef || metadata.orderRef,
      })

    case 'NEW_CONTACT_MESSAGE':
      return buildContactMessageEmail({
        name: customerName || metadata.name || 'Visitor',
        email: customerEmail || metadata.email || '',
        phone: metadata.phone || '',
        subject: title || metadata.subject || 'General Inquiry',
        message: message || metadata.message || '',
      })

    case 'AI_ESCALATION':
    case 'SUPPORT_ESCALATION':
    case 'NEW_SUPPORT_TICKET':
      return buildAIEscalationEmail({
        customerName: customerName || metadata.customerName || 'Customer',
        customerEmail: customerEmail || metadata.customerEmail || '',
        reason: message || metadata.reason || 'Issue requires human assistance',
        priority: priority || metadata.priority || 'high',
        category: category || metadata.category || 'general_support',
        aiSummary: aiSummary || metadata.aiSummary || '',
        recommendedAction: metadata.recommendedAction || '',
        orderRef: orderRef || metadata.orderRef,
      })

    case 'PAYMENT_SUCCESS':
      return buildPaymentSuccessEmail({
        orderRef: orderRef || metadata.orderRef,
        total: total || metadata.total,
        customerName: customerName || metadata.customerName,
        paymentMethod: paymentMethod || metadata.paymentMethod || 'Stripe',
      })

    case 'PAYMENT_FAILED':
      return buildPaymentFailedEmail({
        orderRef: orderRef || metadata.orderRef,
        total: total || metadata.total,
        customerName: customerName || metadata.customerName,
        reason: message || metadata.reason || 'Card payment declined',
      })

    case 'ORDER_STATUS_CHANGED':
    case 'ORDER_STATUS_UPDATED':
    case 'DELIVERY_STATUS_CHANGED':
      return buildOrderStatusEmail({
        orderRef: orderRef || metadata.orderRef,
        status: metadata.status || message || 'updated',
        customerName: customerName || metadata.customerName,
      })

    default:
      return null
  }
}
