import Stripe from 'stripe'
import dotenv from 'dotenv'
dotenv.config()

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || ''
const isStripeConfigured = Boolean(stripeSecretKey && stripeSecretKey.startsWith('sk_'))

export const stripe = isStripeConfigured ? new Stripe(stripeSecretKey) : null

/**
 * Creates a Stripe Checkout Session for an existing order.
 * Calculates authoritative line items and pricing on the server.
 */
export async function createCheckoutSession({
  order,
  cartItems,
  customerEmail,
  successUrl,
  cancelUrl,
}) {
  if (!stripe) {
    throw new Error('Stripe is not configured on the server. Please check STRIPE_SECRET_KEY in server/.env.')
  }

  // Build authoritative Stripe line items
  // Converts PKR pricing (e.g. 28,000 PKR) to USD cents ($100.00 = 10000 cents) for international card gateways
  const lineItems = cartItems.map((item) => {
    // 1 USD ~ 280 PKR for standard exchange calculation
    const unitAmountCents = Math.max(Math.round((item.price / 280) * 100), 50)

    return {
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          description: `OEM Part: ${item.partSlug || 'GENUINE-OEM'}`,
          ...(item.image && item.image.startsWith('http') ? { images: [item.image] } : {}),
        },
        unit_amount: unitAmountCents,
      },
      quantity: Math.max(item.qty || 1, 1),
    }
  })

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: lineItems,
    mode: 'payment',
    customer_email: customerEmail || undefined,
    client_reference_id: order._id.toString(),
    metadata: {
      orderId: order._id.toString(),
      userId: order.user?.toString() || 'guest',
      platform: 'AutoGenuine OEM Store',
    },
    billing_address_collection: 'auto',
    success_url: successUrl,
    cancel_url: cancelUrl,
  })

  return session
}

/**
 * Retrieves a Stripe Checkout Session by ID.
 */
export async function retrieveCheckoutSession(sessionId) {
  if (!stripe) {
    throw new Error('Stripe is not configured on the server.')
  }
  return await stripe.checkout.sessions.retrieve(sessionId)
}

/**
 * Verifies a Stripe Webhook Event using the raw request body and signature header.
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!stripe) {
    throw new Error('Stripe client not initialized')
  }
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured in server/.env')
  }

  return stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret)
}

/**
 * Initiates a refund for a previously captured Payment Intent.
 */
export async function createRefund(paymentIntentId, amount = null, reason = 'requested_by_customer') {
  if (!stripe) {
    throw new Error('Stripe client not initialized')
  }

  const refundParams = {
    payment_intent: paymentIntentId,
    reason,
  }
  if (amount) {
    refundParams.amount = Math.round(amount)
  }

  return await stripe.refunds.create(refundParams)
}
