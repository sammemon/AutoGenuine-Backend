import mongoose from 'mongoose'

/**
 * A single message in a Conversation.
 *
 * Types:
 *   - text     : normal user-typed message
 *   - image    : one or more image attachments
 *   - file     : generic file attachment
 *   - product  : shared product card (linkedPartSlug)
 *   - order    : shared order card (linkedOrderRef)
 *   - system   : server-emitted (e.g. "Conversation created", "User joined")
 *
 * readBy is an array of {user, readAt} so we can show read receipts.
 * edited and deleted are soft flags - we keep the row for history.
 */
const attachmentSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    filename: { type: String, default: '' },
    mimetype: { type: String, default: '' },
    size: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
  },
  { _id: false }
)

const messageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    senderName: { type: String, default: '' },
    senderRole: {
      type: String,
      enum: ['user', 'admin', 'owner', 'ai', 'system'],
      default: 'user',
    },
    isAI: { type: Boolean, default: false, index: true },

    type: {
      type: String,
      enum: ['text', 'image', 'file', 'product', 'order', 'system'],
      default: 'text',
    },

    text: { type: String, default: '' },
    attachments: [attachmentSchema],

    linkedPartSlug: { type: String, default: '' },
    linkedOrderRef: { type: String, default: '' },

    // Structured AI & Escalation Metadata
    aiMetadata: {
      intent: { type: String, default: '' },
      confidence: { type: Number, default: 1 },
      toolsUsed: [{ type: String }],
      escalated: { type: Boolean, default: false },
      reason: { type: String, default: '' },
      recommendedAction: { type: String, default: '' },
      productData: { type: mongoose.Schema.Types.Mixed, default: null },
      orderData: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    escalationData: {
      reason: { type: String, default: '' },
      target: { type: String, default: '' },
      category: { type: String, default: '' },
      priority: { type: String, default: 'medium' },
      aiSummary: { type: String, default: '' },
      recommendedAction: { type: String, default: '' },
    },
    resolutionData: {
      resolvedByName: { type: String, default: '' },
      resolvedByRole: { type: String, default: '' },
      note: { type: String, default: '' },
    },

    readBy: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        readAt: { type: Date, default: Date.now },
      },
    ],

    edited: { type: Boolean, default: false },
    editedAt: { type: Date, default: null },
    deleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedByName: { type: String, default: '' },
    originalText: { type: String, default: '' },
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    reactions: [
      {
        emoji: { type: String, required: true },
        users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      },
    ],
  },
  { timestamps: true }
)

messageSchema.index({ conversation: 1, createdAt: -1 })
messageSchema.index({ conversation: 1, createdAt: 1 })

export default mongoose.model('Message', messageSchema)
