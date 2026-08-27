import express from 'express'
import { requireAuth } from '../middleware/auth.js'
import { register, login, me, updateProfile, changePassword, googleAuth } from '../controllers/authController.js'

const router = express.Router()

router.post('/register', register)
router.post('/login', login)
router.post('/google', googleAuth)
router.get('/me', requireAuth, me)
router.put('/profile', requireAuth, updateProfile)
router.put('/password', requireAuth, changePassword)

export default router
