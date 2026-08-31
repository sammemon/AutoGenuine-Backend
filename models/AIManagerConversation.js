import mongoose from 'mongoose'

const aiMessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    text: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    toolsUsed: [{ type: String }],
    actionProposals: [
      {
        actionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AIStoreAction' },
        actionType: { type: String },
        title: { type: String },
        description: { type: String },
        riskLevel: { type: String },
        targetType: { type: String },
        targetId: { type: String },
        payload: { type: mongoose.Schema.Types.Mixed },
        status: { type: String, default: 'pending_approval' },
      },
    ],
    productDraft: {
      slug: { type: String },
      name: { type: String },
      categorySlug: { type: String },
      categoryName: { type: String },
      fits: { type: String },
      price: { type: Number },
      stock: { type: Number },
      image: { type: String },
      badge: { type: String },
      sku: { type: String },
      oemNumber: { type: String },
      description: { type: String },
      seoTitle: { type: String },
      seoDescription: { type: String },
      tags: [{ type: String }],
      confidence: { type: String },
    },
    analyticsData: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
)

const aiManagerConversationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userName: { type: String, default: '' },
    userRole: { type: String, default: 'owner' },
    title: { type: String, default: 'AI Store Manager Session' },
    messages: [aiMessageSchema],
    isTemporary: { type: Boolean, default: true, index: true },
    savedPermanently: { type: Boolean, default: false },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // default 3 days retention
      index: true,
    },
  },
  { timestamps: true }
)

aiManagerConversationSchema.index({ user: 1, updatedAt: -1 })

export default mongoose.model('AIManagerConversation', aiManagerConversationSchema)
