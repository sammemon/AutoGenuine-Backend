import mongoose from 'mongoose'

const categorySchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true }, // 'brakes', 'engine', ...
  label: { type: String, required: true },
  icon: { type: String, required: true },  // lucide icon name, resolved on the client
  description: { type: String, default: '' },
  image: { type: String, default: '' },
}, { timestamps: true })

export default mongoose.model('Category', categorySchema)
