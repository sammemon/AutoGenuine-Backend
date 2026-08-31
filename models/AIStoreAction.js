import mongoose from 'mongoose'

/**
 * AIStoreAction tracks proposed and executed business actions initiated via AI Store Manager.
 *
 * Workflow:
 * 1. AI decides a mutating action is needed (e.g. create product, update price, adjust stock, dispatch/cancel order).
 * 2. Backend constructs a proposal and saves it as 'pending_approval'.
 * 3. Owner reviews the Proposal Card in the UI and clicks "Approve" or "Reject".
 * 4. On approval, backend executes the action, updates status to 'executed', records AuditLog, and emits Socket.IO event.
 */
const aiStoreActionSchema = new mongoose.Schema(
  {
    actionType: {
      type: String,
      required: true,
      enum: [
        'create_product',
        'bulk_import_products',
        'update_product_price',
        'update_product_stock',
        'bulk_adjust_stock',
        'create_category',
        'update_order_status',
        'cancel_order',
        'archive_product',
      ],
      index: true,
    },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    riskLevel: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
      index: true,
    },
    targetType: {
      type: String,
      enum: ['part', 'order', 'category', 'vehicle', 'inventory', 'store'],
      required: true,
    },
    targetId: { type: String, default: '', index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    previousState: { type: mongoose.Schema.Types.Mixed, default: null },
    status: {
      type: String,
      enum: ['pending_approval', 'approved', 'executed', 'rejected', 'failed', 'expired'],
      default: 'pending_approval',
      index: true,
    },
    proposedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedByName: { type: String, default: '' },
    approvedAt: { type: Date },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, default: '' },
    executionResult: { type: mongoose.Schema.Types.Mixed, default: null },
    errorMessage: { type: String, default: '' },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), // proposals expire in 24 hours if unconfirmed
      index: true,
    },
  },
  { timestamps: true }
)

aiStoreActionSchema.index({ createdAt: -1 })

export default mongoose.model('AIStoreAction', aiStoreActionSchema)
