import Cart from '../models/Cart.js'
import Part from '../models/Part.js'

// The frontend keys cart items by `id` (matching catalog part ids, which equal the slug).
// Server stores items by `partSlug`, so expose `id` on the way out for a consistent shape.
function cartItemOut(item) {
  return {
    id: item.partSlug,
    name: item.name,
    price: item.price,
    originalPrice: item.originalPrice || 0,
    discount: item.discount || 0,
    image: item.image,
    qty: item.qty,
  }
}

function cartOut(cart) {
  return { items: cart.items.map(cartItemOut) }
}

export async function getCart(req, res) {
  let cart = await Cart.findOne({ user: req.user._id })
  if (!cart) cart = await Cart.create({ user: req.user._id, items: [] })
  res.json(cartOut(cart))
}

export async function addToCart(req, res) {
  const { partSlug, qty } = req.body || {}
  if (!partSlug || !qty || qty < 1) {
    return res.status(400).json({ error: 'Part slug and quantity required' })
  }

  const part = await Part.findOne({ slug: partSlug })
  if (!part) return res.status(404).json({ error: 'Part not found' })

  if (part.stock < 1) {
    return res.status(400).json({ error: `"${part.name}" is currently out of stock` })
  }

  let cart = await Cart.findOne({ user: req.user._id })
  if (!cart) cart = await Cart.create({ user: req.user._id, items: [] })

  const existing = cart.items.find((i) => i.partSlug === partSlug)
  const targetQty = (existing ? existing.qty : 0) + qty

  if (targetQty > part.stock) {
    return res.status(400).json({
      error: `Only ${part.stock} units of "${part.name}" available in stock`,
    })
  }

  if (existing) {
    existing.qty += qty
    existing.originalPrice = part.originalPrice || 0
    existing.discount = part.discount || 0
    existing.price = part.price
  } else {
    cart.items.push({
      partSlug,
      name: part.name,
      price: part.price,
      originalPrice: part.originalPrice || 0,
      discount: part.discount || 0,
      image: part.image,
      qty,
    })
  }
  await cart.save()
  res.json(cartOut(cart))
}

export async function updateCartItem(req, res) {
  const { partSlug } = req.params
  const { qty } = req.body || {}
  if (qty === undefined || qty < 0) {
    return res.status(400).json({ error: 'Valid quantity required' })
  }

  const part = await Part.findOne({ slug: partSlug })
  if (!part && qty > 0) return res.status(404).json({ error: 'Part not found' })

  if (part && qty > part.stock) {
    return res.status(400).json({
      error: `Only ${part.stock} units of "${part.name}" available in stock`,
    })
  }

  const cart = await Cart.findOne({ user: req.user._id })
  if (!cart) return res.status(404).json({ error: 'Cart not found' })

  if (qty === 0) {
    cart.items = cart.items.filter((i) => i.partSlug !== partSlug)
  } else {
    const item = cart.items.find((i) => i.partSlug === partSlug)
    if (!item) return res.status(404).json({ error: 'Item not in cart' })
    item.qty = qty
  }
  await cart.save()
  res.json(cartOut(cart))
}

export async function removeFromCart(req, res) {
  const { partSlug } = req.params
  const cart = await Cart.findOne({ user: req.user._id })
  if (!cart) return res.status(404).json({ error: 'Cart not found' })

  cart.items = cart.items.filter((i) => i.partSlug !== partSlug)
  await cart.save()
  res.json(cartOut(cart))
}

export async function clearCart(req, res) {
  const cart = await Cart.findOne({ user: req.user._id })
  if (cart) {
    cart.items = []
    await cart.save()
  }
  res.json({ items: [] })
}
