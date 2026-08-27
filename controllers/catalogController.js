import Part from '../models/Part.js'
import Category from '../models/Category.js'
import Vehicle from '../models/Vehicle.js'
import { getSettingsDoc } from '../models/Settings.js'

// Map DB docs back to the shape the React app already expects.
function partOut(p) {
  const orig = p.originalPrice && p.originalPrice > p.price ? p.originalPrice : Math.round(p.price * 1.14)
  const disc = p.discount || Math.round((1 - p.price / orig) * 100)
  return {
    id: p.slug,
    slug: p.slug,
    categoryId: p.categorySlug,
    categorySlug: p.categorySlug,
    badge: p.badge,
    name: p.name,
    fits: p.fits,
    price: p.price,
    originalPrice: orig,
    image: p.image,
    stock: p.stock,
    featured: p.featured,
    popular: p.popular,
    active: p.active !== false,
    sku: p.sku,
    oemNumber: p.oemNumber,
    discount: disc,
  }
}

function categoryOut(c) {
  return {
    id: c.slug,
    slug: c.slug,
    label: c.label,
    icon: c.icon,
    description: c.description,
    image: c.image,
  }
}

export async function listParts(req, res) {
  const { category, search } = req.query
  const filter = { active: { $ne: false } }
  if (category && category !== 'all') {
    filter.categorySlug = category
  }
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { fits: { $regex: search, $options: 'i' } },
      { sku: { $regex: search, $options: 'i' } },
    ]
  }
  const parts = await Part.find(filter).sort({ createdAt: -1 })
  res.json(parts.map(partOut))
}

export async function getPart(req, res) {
  const part = await Part.findOne({ slug: req.params.slug })
  if (!part) return res.status(404).json({ error: 'Part not found' })
  res.json(partOut(part))
}

export async function listCategories(req, res) {
  const categories = await Category.find().sort({ createdAt: 1 })
  res.json(categories.map(categoryOut))
}

export async function listVehicles(req, res) {
  const vehicles = await Vehicle.find().sort({ make: 1, model: 1 }).lean()
  // Group into makes, matching the frontend's makes[] shape, with live parts count.
  const byMake = {}
  for (const v of vehicles) {
    const realPartsCount = await Part.countDocuments({
      fits: { $regex: new RegExp(v.model, 'i') }
    })
    const dynamicPartsLabel = `${realPartsCount} Parts`

    if (!byMake[v.make]) byMake[v.make] = { make: v.make, inStock: v.inStock, models: [] }
    byMake[v.make].models.push({
      model: v.model, from: v.from, to: v.to, parts: dynamicPartsLabel, image: v.image,
    })
    if (v.inStock) byMake[v.make].inStock = true
  }
  res.json(Object.values(byMake))
}

export async function getStoreSettings(req, res) {
  const doc = await getSettingsDoc()
  res.json({
    storeName: doc.storeName,
    tagline: doc.tagline,
    supportEmail: doc.supportEmail,
    supportPhone: doc.supportPhone,
    whatsappNumber: doc.whatsappNumber || '+923213498203',
    address: doc.address,
    currency: doc.currency,
    shippingFee: doc.shippingFee,
    freeShippingOver: doc.freeShippingOver,
    taxRate: doc.taxRate,
    announcement: doc.announcement,
  })
}
