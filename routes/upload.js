import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { handleUpload } from '../middleware/upload.js'

const router = Router()

// POST /api/upload
// Requires authentication (works for admin, owner, and customers updating profile photo)
router.post('/', requireAuth, handleUpload, (req, res) => {
  const file = req.file
  if (!file) {
    return res.status(400).json({ error: 'No image file uploaded.' })
  }

  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https'
  const host = req.get('host')
  const relativeUrl = `/uploads/${file.filename}`
  const absoluteUrl = `${protocol}://${host}${relativeUrl}`

  res.status(201).json({
    url: absoluteUrl,
    relativeUrl,
    filename: file.filename,
    originalName: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
  })
})

export default router
