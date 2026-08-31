import mongoose from 'mongoose'

/**
 * A Conversation is a thread between 2+ participants.
 *
 * - type is 'direct' (1:1) or 'group'.
 * - For 'direct', participant order is irrelevant; we always dedupe and canonicalize
 *   so the same two users only have one conversation.
 * - For 'group', name and admins apply.
 * - lastMessage is denormalized for fast list rendering.
 * - unreadBy tracks per-user unread counts (avoids recounting on every read).
 * - mutedBy / pinnedBy are user-id sets for per-conversation preferences.
 */
const conversationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['direct', 'group'], default: 'direct', index: true },
    name: { type: String, default: '' },
    participants: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ],
    admins: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    orderRef: { type: String, default: '', index: true },
    productSlug: { type: String, default: '', index: true },

    // AI Support & Escalation fields
    isSupport: { type: Boolean, default: false, index: true },
    isTemporary: { type: Boolean, default: false, index: true },
    savedPermanently: { type: Boolean, default: false },
    expiresAt: { type: Date, default: null, index: true },
    supportStatus: {
      type: String,
      enum: [
        'ai_active',
        'waiting_for_customer',
        'escalation_pending',
        'reopen_requested',
        'assigned_to_admin',
        'assigned_to_store_owner',
        'human_active',
        'resolved',
        'closed',
      ],
      default: 'human_active',
      index: true,
    },
    supportCategory: {
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
    aiHandled: { type: Boolean, default: false },
    escalated: { type: Boolean, default: false, index: true },
    escalationReason: { type: String, default: '' },
    escalationTarget: {
      type: String,
      enum: ['admin', 'owner', ''],
      default: '',
    },
    assignedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    assignedRole: {
      type: String,
      enum: ['admin', 'owner', 'user', ''],
      default: '',
    },
    aiSummary: { type: String, default: '' },
    recommendedAction: { type: String, default: '' },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedByName: { type: String, default: '' },
    resolvedAt: { type: Date },
    resolutionNote: { type: String, default: '' },
    rating: { type: Number, min: 1, max: 5 },
    feedback: { type: String, default: '' },

    lastMessage: {
      _id: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
      text: { type: String, default: '' },
      sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      senderName: { type: String, default: '' },
      type: { type: String, default: 'text' },
      deleted: { type: Boolean, default: false },
      deletedByName: { type: String, default: '' },
      deletedByRole: { type: String, default: '' },
      createdAt: { type: Date, default: Date.now },
    },

    unreadBy: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        count: { type: Number, default: 0 },
      },
    ],

    mutedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    pinnedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    isArchived: { type: Boolean, default: false },
    archivedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    clearedBy: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        clearedAt: { type: Date, default: Date.now },
      },
    ],
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
)

conversationSchema.index({ participants: 1, updatedAt: -1 })

export default mongoose.model('Conversation', conversationSchema)
