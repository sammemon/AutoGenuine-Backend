import mongoose from 'mongoose'

/**
 * A block relationship between two users. If A blocks B, A will not see
 * messages from B and B cannot start a new conversation with A.
 */
const userBlockSchema = new mongoose.Schema(
  {
    blocker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    blocked: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reason: { type: String, default: '' },
  },
  { timestamps: true }
)

userBlockSchema.index({ blocker: 1, blocked: 1 }, { unique: true })

export default mongoose.model('UserBlock', userBlockSchema)
