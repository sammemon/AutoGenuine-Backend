import mongoose from 'mongoose'

const partSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true }, // 'brake-pad-camry'
  categorySlug: { type: String, required: true, index: true }, // 'brakes'
  badge: { type: String, default: '' },  // 'OEM' | 'GENUINE'
  name: { type: String, required: true },
  fits: { type: String, default: '' },
  price: { type: Number, required: true },
  originalPrice: { type: Number, default: 0 }, // MSRP / List price for strikethrough comparison
  image: { type: String, default: '' },
  stock: { type: Number, default: 50 },
  sku: { type: String, default: '' },        // stock-keeping unit
  oemNumber: { type: String, default: '' },  // manufacturer OEM part number
  discount: { type: Number, default: 0 },    // percent off, 0–100
  featured: { type: Boolean, default: false },
  popular: { type: Boolean, default: false },
  active: { type: Boolean, default: true },  // deactivated parts hide from storefront-ready views
}, { timestamps: true })

export default mongoose.model('Part', partSchema)
