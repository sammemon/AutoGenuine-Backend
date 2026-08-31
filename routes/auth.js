import express from 'express'
import { requireAuth } from '../middleware/auth.js'
import { authRateLimiter } from '../middleware/rateLimiter.js'
import { register, login, me, updateProfile, changePassword, googleAuth, forgotPassword, verifyResetCode, resetPassword } from '../controllers/authController.js'

const router = express.Router()

router.post('/register', authRateLimiter, register)
router.post('/login', authRateLimiter, login)
router.post('/google', googleAuth)
router.post('/forgot-password', authRateLimiter, forgotPassword)
router.post('/verify-reset-code', verifyResetCode)
router.post('/reset-password', authRateLimiter, resetPassword)
router.get('/me', requireAuth, me)
router.put('/profile', requireAuth, updateProfile)
router.put('/password', requireAuth, changePassword)

export default router
