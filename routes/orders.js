import express from 'express'
import { requireAuth } from '../middleware/auth.js'
import { listOrders, createOrder, getOrder, cancelOrder, trackOrder } from '../controllers/orderController.js'

const router = express.Router()

// Public Order Tracking by Reference/ID (accessible without sign in)
router.get('/track', trackOrder)
router.get('/track/:query', trackOrder)

router.get('/', requireAuth, listOrders)
router.post('/', requireAuth, createOrder)
router.get('/:id', requireAuth, getOrder)
router.put('/:id/cancel', requireAuth, cancelOrder)
router.post('/:id/cancel', requireAuth, cancelOrder)

export default router
