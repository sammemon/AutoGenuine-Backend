import express from 'express'
import { requireAuth } from '../middleware/auth.js'
import { getCart, addToCart, updateCartItem, removeFromCart, clearCart } from '../controllers/cartController.js'

const router = express.Router()

router.get('/', requireAuth, getCart)
router.post('/', requireAuth, addToCart)
router.put('/:partSlug', requireAuth, updateCartItem)
router.delete('/:partSlug', requireAuth, removeFromCart)
router.delete('/', requireAuth, clearCart)

export default router
