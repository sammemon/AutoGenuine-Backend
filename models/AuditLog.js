// Immutable audit trail of staff actions. Written by adminController whenever a
// privileged action succeeds (role change, suspension, product/order edits, …).
// Viewable by the Store Owner only. The model is append-only — there is no
// update or delete route.
import mongoose from 'mongoose'

const auditLogSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorEmail: { type: String, default: '' },
  action: { type: String, required: true },        // e.g. 'user.suspend', 'order.status', 'part.update'
  targetType: { type: String, default: '' },       // 'user' | 'order' | 'part' | 'category' | 'vehicle' | 'message' | 'settings' | 'ai_manager'
  targetId: { type: String, default: '' },
  details: { type: String, default: '' },          // human-readable summary
  aiGenerated: { type: Boolean, default: false },  // triggered/proposed by AI Store Manager
  userConfirmed: { type: Boolean, default: false },// confirmed by store owner/admin
  beforeValue: { type: mongoose.Schema.Types.Mixed, default: null },
  afterValue: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true })

auditLogSchema.index({ createdAt: -1 })

export default mongoose.model('AuditLog', auditLogSchema)
