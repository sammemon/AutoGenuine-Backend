import mongoose from 'mongoose'

const notificationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        'NEW_ORDER',
        'NEW_MESSAGE',
        'NEW_SUPPORT_TICKET',
        'NEW_CONTACT_MESSAGE',
        'AI_ESCALATION',
        'PAYMENT_SUCCESS',
        'PAYMENT_FAILED',
        'ORDER_STATUS_CHANGED',
        'ORDER_STATUS_UPDATED',
        'ORDER_CANCELLED',
        'DELIVERY_STATUS_CHANGED',
        'SYSTEM_ALERT',
        'LOW_STOCK',
        'GENERAL',
        'SUPPORT_ESCALATION',
        'SUPPORT_MESSAGE',
        'SUPPORT_ASSIGNED',
        'SUPPORT_RESOLVED',
      ],
      required: true,
      default: 'NEW_ORDER',
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    recipientRole: {
      type: String,
      enum: ['user', 'admin', 'owner', 'staff', 'all'],
      default: 'staff',
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
    },
    orderRef: {
      type: String,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
    },
    ticketId: {
      type: String,
    },
    customerName: {
      type: String,
    },
    customerEmail: {
      type: String,
    },
    total: {
      type: Number,
    },
    paymentMethod: {
      type: String,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium',
    },
    category: {
      type: String,
      default: 'general_support',
    },
    aiSummary: {
      type: String,
      default: '',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    read: {
      type: Boolean,
      default: false,
    },
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    emailSent: {
      type: Boolean,
      default: false,
    },
    emailSentAt: {
      type: Date,
    },
    emailFailed: {
      type: Boolean,
      default: false,
    },
    emailError: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
)

export default mongoose.model('Notification', notificationSchema)
