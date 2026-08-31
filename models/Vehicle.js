import mongoose from 'mongoose'

const vehicleSchema = new mongoose.Schema({
  make: { type: String, required: true, index: true },
  model: { type: String, required: true },
  from: { type: Number, required: true },
  to: { type: Number, required: true },
  parts: { type: String, default: '' },  // display string e.g. '1,200+'
  image: { type: String, default: '' },
  inStock: { type: Boolean, default: false },
}, { timestamps: true })

export default mongoose.model('Vehicle', vehicleSchema)
