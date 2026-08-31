import { Router } from 'express'
import {
  getStripeConfig,
  createCheckoutSession,
  getSessionDetails,
} from '../controllers/stripeController.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

// Public config
router.get('/config', getStripeConfig)

// Create Stripe Checkout Session (Requires authenticated user)
router.post('/create-checkout-session', requireAuth, createCheckoutSession)

// Retrieve session & verified order details
router.get('/session/:sessionId', getSessionDetails)

export default router
