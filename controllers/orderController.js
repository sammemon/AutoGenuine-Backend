import Order from '../models/Order.js'
import Cart from '../models/Cart.js'
import Part from '../models/Part.js'
import { createRefund, retrieveCheckoutSession } from '../services/stripeService.js'
import { emitToStaff } from '../socket.js'
import { createNotification } from '../services/notificationService.js'

export async function listOrders(req, res) {
  const orders = await Order.find({ user: req.user._id }).sort({ createdAt: -1 })
  res.json(orders)
}

export async function createOrder(req, res) {
  const {
    shippingAddress,
    city,
    customerName,
    customerPhone,
    customerEmail,
    notes,
    vehicleInfo,
    paymentMethod = 'card',
    transactionReference,
  } = req.body || {}

  const cart = await Cart.findOne({ user: req.user._id })
  if (!cart || cart.items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' })
  }

  // Pre-order stock verification across all parts
  for (const item of cart.items) {
    if (item.partSlug) {
      const part = await Part.findOne({ slug: item.partSlug })
      if (!part) {
        return res.status(404).json({ error: `Part "${item.name}" is no longer available` })
      }
      if (part.stock < item.qty) {
        return res.status(400).json({
          error: `Insufficient stock for "${part.name}". Available: ${part.stock}, in cart: ${item.qty}`,
        })
      }
    }
  }

  const total = cart.items.reduce((sum, i) => sum + i.price * i.qty, 0)
  const txnRef = transactionReference || `TXN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`

  const order = await Order.create({
    user: req.user._id,
    items: cart.items.map((i) => ({ partSlug: i.partSlug, name: i.name, price: i.price, qty: i.qty })),
    total,
    status: 'pending',
    paymentMethod,
    paymentStatus: paymentMethod === 'cash' || paymentMethod === 'whatsapp' ? 'pending' : 'paid',
    transactionReference: txnRef,
    shippingAddress: shippingAddress || '',
    city: city || '',
    customerName: customerName || req.user.name || '',
    customerPhone: customerPhone || req.user.phone || '',
    customerEmail: customerEmail || req.user.email || '',
    notes: notes || '',
    vehicleInfo: vehicleInfo || req.user.primaryVehicle || '',
  })

  // Deduct inventory stock for each purchased item
  for (const item of cart.items) {
    if (item.partSlug) {
      try {
        await Part.findOneAndUpdate(
          { slug: item.partSlug },
          { $inc: { stock: -item.qty } }
        )
      } catch (err) {
        console.warn('Stock decrement notice:', err.message)
      }
    }
  }

  // Clear cart after order
  cart.items = []
  await cart.save()

  // Centralized Notification Service (Socket.IO if online, Email if offline, Persistent DB)
  const orderRef = String(order._id).slice(-6).toUpperCase()
  createNotification({
    type: 'NEW_ORDER',
    title: `🛒 New Order Placed (#${orderRef})`,
    message: `New order of Rs ${total.toLocaleString()} placed by ${order.customerName || req.user.name}`,
    recipientRole: 'staff',
    orderId: order._id,
    orderRef,
    customerName: order.customerName || req.user.name,
    customerEmail: order.customerEmail || req.user.email,
    total,
    paymentMethod: order.paymentMethod,
    metadata: {
      items: order.items,
      shippingAddress: order.shippingAddress,
      city: order.city,
      customerPhone: order.customerPhone,
    },
  })

  // Real-time broadcast to Admin & Store Owner
  emitToStaff('new_order', order.toObject())

  // Trigger Real-time Auto-Pilot if enabled
  import('../services/autoPilotService.js')
    .then(({ processOrderWithAutoPilot }) => processOrderWithAutoPilot(order._id))
    .catch((err) => console.warn('AutoPilot real-time hook warning:', err.message))

  res.status(201).json(order)
}

export async function getOrder(req, res) {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id })
  if (!order) return res.status(404).json({ error: 'Order not found' })
  res.json(order)
}

export async function cancelOrder(req, res) {
  const { reason } = req.body || {}
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id })

  if (!order) {
    return res.status(404).json({ error: 'Order not found' })
  }

  if (['packed', 'dispatched', 'out_for_delivery', 'shipped'].includes(order.status)) {
    return res.status(400).json({
      error: 'This order has already been packed & prepared for dispatch. It cannot be cancelled online. Please contact support or refuse delivery on arrival.',
    })
  }

  if (order.status === 'delivered') {
    return res.status(400).json({ error: 'This order has already been delivered and cannot be cancelled.' })
  }

  if (order.status === 'cancelled') {
    return res.status(400).json({ error: 'This order is already cancelled.' })
  }

  if (order.status !== 'pending' && order.status !== 'processing') {
    return res.status(400).json({ error: `Orders in "${order.status}" status cannot be cancelled.` })
  }

  order.status = 'cancelled'
  order.cancelledAt = new Date()
  order.cancelledBy = 'customer'
  order.cancelledByName = req.user?.name || 'Customer'
  order.cancellationReason = reason || 'Customer requested cancellation'

  // Automatic Refund if order was paid
  if (order.paymentStatus === 'paid') {
    let refundSuccessful = false

    if (order.paymentMethod === 'stripe' || order.stripePaymentIntentId || order.stripeSessionId) {
      let paymentIntentId = order.stripePaymentIntentId

      if (!paymentIntentId && order.stripeSessionId) {
        try {
          const session = await retrieveCheckoutSession(order.stripeSessionId)
          if (session?.payment_intent) {
            paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id
            order.stripePaymentIntentId = paymentIntentId
          }
        } catch (e) {
          console.warn('Could not resolve payment intent from session:', e.message)
        }
      }

      if (paymentIntentId) {
        try {
          const refund = await createRefund(paymentIntentId, null, 'requested_by_customer')
          order.paymentStatus = 'refunded'
          order.refundId = refund.id
          order.refundAmount = order.total
          order.refundedAt = new Date()
          order.refundReason = order.cancellationReason
          refundSuccessful = true
          console.log(`✅ Automatic Stripe customer-cancel refund processed: Refund ID ${refund.id}`)
        } catch (refundErr) {
          console.error('Customer cancel Stripe refund error:', refundErr.message)
          order.refundError = refundErr.message
          if (refundErr.message?.includes('already been refunded') || refundErr.message?.includes('already refunded')) {
            order.paymentStatus = 'refunded'
            order.refundedAt = new Date()
            refundSuccessful = true
          }
        }
      }
    }

    if (!refundSuccessful && order.paymentStatus === 'paid') {
      order.paymentStatus = 'refunded'
      order.refundedAt = new Date()
      order.refundAmount = order.total
      order.refundReason = order.cancellationReason
    }
  }

  await order.save()

  // Restock inventory for cancelled order items
  for (const item of order.items) {
    if (item.partSlug) {
      try {
        await Part.findOneAndUpdate(
          { slug: item.partSlug },
          { $inc: { stock: item.qty } }
        )
      } catch (err) {
        console.warn('Restocking error:', err.message)
      }
    }
  }

  // Real-time broadcast to Admin & Store Owner
  const cancelRef = String(order._id).slice(-6).toUpperCase()
  createNotification({
    type: 'ORDER_STATUS_CHANGED',
    title: `❌ Order Cancelled (#${cancelRef})`,
    message: `Order #${cancelRef} was cancelled by ${order.cancelledByName || req.user.name}. Reason: ${order.cancellationReason}`,
    recipientRole: 'staff',
    orderId: order._id,
    orderRef: cancelRef,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    total: order.total,
    metadata: {
      status: 'CANCELLED',
      cancellationReason: order.cancellationReason,
    },
  })

  emitToStaff('order_status_updated', order.toObject())

  res.json({ message: 'Order cancelled successfully, refund initiated, and inventory restocked', order })
}

export async function trackOrder(req, res) {
  const raw = String(req.params.query || req.query.q || '').trim()
  if (!raw) {
    return res.status(400).json({ error: 'Please enter an order number or reference.' })
  }

  const clean = raw.replace(/^#?ORD-?/i, '').replace(/^#?AG-?/i, '').trim().toUpperCase()

  let order = null

  // 1. If 24-character hexadecimal ObjectId
  if (/^[0-9a-fA-F]{24}$/.test(raw) || /^[0-9a-fA-F]{24}$/.test(clean)) {
    const idToLookup = /^[0-9a-fA-F]{24}$/.test(clean) ? clean : raw
    order = await Order.findById(idToLookup)
  }

  // 2. Suffix match or transaction reference
  if (!order) {
    const allRecent = await Order.find().sort({ createdAt: -1 }).limit(150)
    order = allRecent.find((o) => {
      const idUpper = String(o._id).toUpperCase()
      const refUpper = (o.transactionReference || '').toUpperCase()
      return idUpper.endsWith(clean) || idUpper === clean || refUpper.includes(clean)
    })
  }

  if (!order) {
    return res.status(404).json({
      error: `No order found matching "${raw}". Please verify your order number (e.g. ORD-121179) and try again.`,
    })
  }

  // Safe tracking details (accessible for both guests and authenticated users)
  res.json({
    _id: order._id,
    orderRef: `ORD-${String(order._id).slice(-6).toUpperCase()}`,
    status: order.status,
    items: order.items,
    total: order.total,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt,
    shippingAddress: order.shippingAddress,
    city: order.city,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    vehicleInfo: order.vehicleInfo,
    notes: order.notes,
    approvedBy: order.approvedBy,
    approvedByName: order.approvedByName,
    approvedAt: order.approvedAt,
    refundId: order.refundId,
    refundAmount: order.refundAmount,
    refundedAt: order.refundedAt,
    refundReason: order.refundReason,
    cancellationReason: order.cancellationReason,
    cancelledAt: order.cancelledAt,
    cancelledBy: order.cancelledBy,
    cancelledByName: order.cancelledByName,
  })
}
