import Order from '../models/Order.js'
import Cart from '../models/Cart.js'
import Part from '../models/Part.js'
import {
  createCheckoutSession as createStripeSession,
  retrieveCheckoutSession,
  verifyWebhookSignature,
} from '../services/stripeService.js'
import { emitToStaff } from '../socket.js'
import { createNotification } from '../services/notificationService.js'

/**
 * Returns public Stripe configuration for the frontend
 */
export async function getStripeConfig(req, res) {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    isConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
  })
}

/**
 * Creates a Stripe Checkout Session for the current user's cart.
 * Authoritative: DB validates all prices, stock, and creates an order in 'pending' status.
 */
export async function createCheckoutSession(req, res) {
  try {
    const {
      shippingAddress = '',
      city = '',
      customerName = '',
      customerPhone = '',
      customerEmail = '',
      notes = '',
      vehicleInfo = '',
    } = req.body || {}

    // 1. Fetch user's cart
    const cart = await Cart.findOne({ user: req.user._id })
    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty. Please add parts before checking out.' })
    }

    // 2. Authoritative Database validation of stock and prices
    const validatedItems = []
    let authoritativeTotal = 0

    for (const item of cart.items) {
      if (!item.partSlug) {
        return res.status(400).json({ error: 'Invalid cart item without part identifier.' })
      }

      const dbPart = await Part.findOne({ slug: item.partSlug })
      if (!dbPart) {
        return res.status(404).json({ error: `Part "${item.name}" is no longer available in inventory.` })
      }

      if (dbPart.stock < item.qty) {
        return res.status(400).json({
          error: `Insufficient stock for "${dbPart.name}". Available: ${dbPart.stock}, Requested: ${item.qty}`,
        })
      }

      // Use database price as authoritative source of truth
      const actualPrice = dbPart.price
      const qty = Math.max(item.qty || 1, 1)
      authoritativeTotal += actualPrice * qty

      validatedItems.push({
        partSlug: dbPart.slug,
        name: dbPart.name,
        price: actualPrice,
        qty: qty,
        image: dbPart.image || '',
      })
    }

    // 3. Create initial Order in MongoDB with pending status
    const tempTxnRef = `STRIPE-${Date.now().toString(36).toUpperCase()}`
    const order = await Order.create({
      user: req.user._id,
      items: validatedItems.map((i) => ({ partSlug: i.partSlug, name: i.name, price: i.price, qty: i.qty })),
      total: authoritativeTotal,
      status: 'pending',
      paymentMethod: 'stripe',
      paymentStatus: 'pending',
      transactionReference: tempTxnRef,
      shippingAddress: shippingAddress || '',
      city: city || '',
      customerName: customerName || req.user.name || '',
      customerPhone: customerPhone || req.user.phone || '',
      customerEmail: customerEmail || req.user.email || '',
      notes: notes || '',
      vehicleInfo: vehicleInfo || req.user.primaryVehicle || '',
    })

    // 4. Construct Frontend Success & Cancel redirect URLs
    const clientUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
    const successUrl = `${clientUrl}/#/payment-success?session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = `${clientUrl}/#/payment-cancelled?order_id=${order._id}`

    // 5. Create Stripe Checkout Session
    let session
    try {
      session = await createStripeSession({
        order,
        cartItems: validatedItems,
        customerEmail: customerEmail || req.user.email,
        successUrl,
        cancelUrl,
      })
    } catch (stripeErr) {
      // ROLLBACK: Delete the temporary draft order so no unpaid orphan order is left in the system
      if (order?._id) {
        await Order.findByIdAndDelete(order._id).catch(() => {})
      }

      console.error('Stripe Checkout API Notice:', stripeErr.message)

      if (stripeErr.message?.includes('account or business name')) {
        return res.status(400).json({
          error: 'Stripe Live Setup Required: Please set your Public Business Name at https://dashboard.stripe.com/account (Takes 30 seconds).',
        })
      }

      return res.status(400).json({
        error: stripeErr.message || 'Stripe Checkout initialization failed. Please check your card or Stripe configuration.',
      })
    }

    // 6. Update order with Stripe Session ID
    order.stripeSessionId = session.id
    order.transactionReference = session.id
    await order.save()

    res.json({
      url: session.url,
      sessionId: session.id,
      orderId: order._id,
    })
  } catch (err) {
    console.error('Stripe Checkout Session Error:', err)
    res.status(500).json({ error: err.message || 'Failed to initialize Stripe Checkout Session' })
  }
}

/**
 * Retrieves Stripe Session and corresponding MongoDB order for the payment success page.
 */
export async function getSessionDetails(req, res) {
  try {
    const { sessionId } = req.params
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' })
    }

    // 1. Fetch order from MongoDB
    const order = await Order.findOne({ stripeSessionId: sessionId }).populate('user', 'name email phone')

    // 2. Fetch session from Stripe
    let stripeSession = null
    try {
      stripeSession = await retrieveCheckoutSession(sessionId)
    } catch (e) {
      console.warn('Could not retrieve remote Stripe session:', e.message)
    }

    if (!order) {
      return res.status(404).json({ error: 'Order associated with this payment session was not found.' })
    }

    // If Stripe session says paid but webhook hasn't fired yet, sync order immediately
    if (stripeSession?.payment_status === 'paid' && order.paymentStatus !== 'paid') {
      order.paymentStatus = 'paid'
      order.status = 'pending' // Remains pending until admin or store owner approves the order
      order.paidAt = new Date()
      if (stripeSession.payment_intent) {
        order.stripePaymentIntentId = stripeSession.payment_intent
      }
      await order.save()

      // Deduct inventory stock
      for (const item of order.items) {
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

      // Clear user cart
      if (order.user) {
        try {
          await Cart.findOneAndUpdate({ user: order.user._id || order.user }, { items: [] })
        } catch (err) {
          console.warn('Cart clear notice:', err.message)
        }
      }

      // Notify admin and store owner
      emitToStaff('new_order', order.toObject())

      // Real-time Auto-Pilot immediate sync
      import('../services/autoPilotService.js')
        .then(({ processOrderWithAutoPilot }) => processOrderWithAutoPilot(order._id))
        .catch((err) => console.warn('AutoPilot stripe sync warning:', err.message))
    }

    res.json({
      order,
      session: {
        id: stripeSession?.id || sessionId,
        paymentStatus: stripeSession?.payment_status || order.paymentStatus,
        customerEmail: stripeSession?.customer_details?.email || order.customerEmail,
        amountTotal: stripeSession?.amount_total || (order.total / 280) * 100,
        currency: stripeSession?.currency || 'usd',
      },
    })
  } catch (err) {
    console.error('Get Session Details Error:', err)
    res.status(500).json({ error: err.message || 'Failed to retrieve payment session details' })
  }
}

/**
 * Production-ready Stripe Webhook Handler.
 * Verifies signature, updates order to 'paid', deducts inventory, clears cart, and alerts staff.
 */
export async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature']

  let event
  try {
    event = verifyWebhookSignature(req.body, sig)
  } catch (err) {
    console.error('⚠️ Stripe Webhook Signature Verification Failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  // Handle specific Stripe events
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object
      const orderId = session.metadata?.orderId || session.client_reference_id
      const sessionId = session.id

      try {
        let order = null
        if (orderId) {
          order = await Order.findById(orderId)
        } else if (sessionId) {
          order = await Order.findOne({ stripeSessionId: sessionId })
        }

        if (!order) {
          console.warn(`Webhook: Order not found for session ${sessionId} / order ${orderId}`)
          return res.json({ received: true, note: 'Order not found' })
        }

        // Idempotency check: if already paid, skip duplicate processing
        if (order.paymentStatus === 'paid') {
          return res.json({ received: true, note: 'Order already marked as paid' })
        }

        // Mark as paid; order remains pending awaiting admin/owner approval
        order.paymentStatus = 'paid'
        order.status = 'pending'
        order.paidAt = new Date()
        order.stripePaymentIntentId = session.payment_intent || ''
        await order.save()

        // Deduct inventory stock
        for (const item of order.items) {
          if (item.partSlug) {
            try {
              await Part.findOneAndUpdate(
                { slug: item.partSlug },
                { $inc: { stock: -item.qty } }
              )
            } catch (err) {
              console.warn('Webhook inventory decrement warning:', err.message)
            }
          }
        }

        // Clear customer cart
        if (order.user) {
          try {
            await Cart.findOneAndUpdate({ user: order.user }, { items: [] })
          } catch (err) {
            console.warn('Webhook cart clear warning:', err.message)
          }
        }

        // Dispatch PAYMENT_SUCCESS notification via Notification Service (Socket if online, Email if offline)
        const stripeRef = String(order._id).slice(-6).toUpperCase()
        createNotification({
          type: 'PAYMENT_SUCCESS',
          title: `💳 Stripe Payment Verified (#${stripeRef})`,
          message: `Stripe payment of Rs ${order.total.toLocaleString()} confirmed for Order #${stripeRef}`,
          recipientRole: 'staff',
          orderId: order._id,
          orderRef: stripeRef,
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          total: order.total,
          paymentMethod: 'Stripe',
        })

        // Also notify customer of payment confirmation
        if (order.user) {
          createNotification({
            type: 'PAYMENT_SUCCESS',
            title: `💳 Payment Received (#${stripeRef})`,
            message: `Your payment of Rs ${order.total.toLocaleString()} for Order #${stripeRef} has been verified.`,
            recipient: order.user,
            recipientRole: 'user',
            orderId: order._id,
            orderRef: stripeRef,
            customerName: order.customerName,
            customerEmail: order.customerEmail,
            total: order.total,
            paymentMethod: 'Stripe',
          })
        }

        // Broadcast real-time notifications to Admin & Store Owner
        emitToStaff('new_order', order.toObject())
        emitToStaff('order_status_updated', order.toObject())

        console.log(`✅ Webhook: Order #${String(order._id).slice(-6).toUpperCase()} marked as PAID via Stripe!`)
      } catch (err) {
        console.error('Webhook processing error for checkout.session.completed:', err)
        return res.status(500).json({ error: 'Failed to process order update' })
      }
      break
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object
      try {
        const order = await Order.findOne({ stripePaymentIntentId: paymentIntent.id })
        if (order && order.paymentStatus !== 'paid') {
          order.paymentStatus = 'failed'
          await order.save()

          const failRef = String(order._id).slice(-6).toUpperCase()
          createNotification({
            type: 'PAYMENT_FAILED',
            title: `⚠️ Stripe Payment Failed (#${failRef})`,
            message: `Payment failed for Order #${failRef}. Reason: ${paymentIntent.last_payment_error?.message || 'Card declined'}`,
            recipientRole: 'staff',
            orderId: order._id,
            orderRef: failRef,
            customerName: order.customerName,
            customerEmail: order.customerEmail,
            total: order.total,
            metadata: { reason: paymentIntent.last_payment_error?.message || 'Card declined' },
          })

          emitToStaff('order_status_updated', order.toObject())
        }
      } catch (err) {
        console.error('Webhook error on payment_intent.payment_failed:', err)
      }
      break
    }

    default:
      // Other unhandled events
      break
  }

  res.json({ received: true })
}
