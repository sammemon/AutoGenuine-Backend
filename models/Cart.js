import mongoose from 'mongoose'

const cartItemSchema = new mongoose.Schema({
  partSlug: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  originalPrice: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  image: { type: String, default: '' },
  qty: { type: Number, required: true, min: 1 },
}, { _id: false })

const cartSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  items: { type: [cartItemSchema], default: [] },
  lastReminderSentAt: { type: Date },
}, { timestamps: true })

export default mongoose.model('Cart', cartSchema)
