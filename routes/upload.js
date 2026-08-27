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

  // Relative path served statically via Express at /uploads/:filename
  const relativeUrl = `/uploads/${file.filename}`

  res.status(201).json({
    url: relativeUrl,
    filename: file.filename,
    originalName: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
  })
})

export default router
