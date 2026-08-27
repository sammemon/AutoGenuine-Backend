import mongoose from 'mongoose'

/**
 * SupportEscalation records every conversation escalation from AI to Human staff.
 * Provides historical audit, metrics, and queue filtering for Admin and Store Owner dashboards.
 */
const supportEscalationSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    customerName: { type: String, default: '' },
    customerEmail: { type: String, default: '' },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    assignedRole: {
      type: String,
      enum: ['admin', 'owner'],
      required: true,
      index: true,
    },
    reason: { type: String, required: true },
    category: {
      type: String,
      enum: [
        'general_support',
        'order_support',
        'payment_support',
        'delivery_support',
        'product_support',
        'store_support',
        'account_support',
        'technical_support',
      ],
      default: 'general_support',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium',
      index: true,
    },
    aiSummary: { type: String, default: '' },
    recommendedAction: { type: String, default: '' },
    orderRef: { type: String, default: '', index: true },
    productSlug: { type: String, default: '', index: true },
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'resolved'],
      default: 'pending',
      index: true,
    },
    resolvedAt: { type: Date },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolutionNote: { type: String, default: '' },
  },
  { timestamps: true }
)

supportEscalationSchema.index({ status: 1, priority: 1, createdAt: -1 })

export default mongoose.model('SupportEscalation', supportEscalationSchema)
