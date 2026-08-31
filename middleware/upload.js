import multer from 'multer'
import path from 'path'
import crypto from 'crypto'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Ensure upload directory exists in server/uploads
const uploadDir = path.resolve(__dirname, '../uploads')
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
])

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : '.jpg'
    const randomSuffix = crypto.randomBytes(8).toString('hex')
    const uniqueName = `${Date.now()}-${randomSuffix}${safeExt}`
    cb(null, uniqueName)
  },
})

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase()
  const mime = file.mimetype.toLowerCase()

  if (!ALLOWED_MIME_TYPES.has(mime) || !ALLOWED_EXTENSIONS.has(ext)) {
    const err = new Error('Please upload a JPG, PNG, or WEBP image.')
    err.code = 'INVALID_FILE_TYPE'
    return cb(err, false)
  }

  cb(null, true)
}

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB max
    files: 1,
  },
})

// Middleware wrapper to return clean user-facing error responses
export function handleUpload(req, res, next) {
  const singleUpload = upload.single('image')

  singleUpload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image size must be 5 MB or less.' })
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` })
    }
    if (err) {
      return res.status(400).json({ error: err.message || 'Please upload a JPG, PNG, or WEBP image.' })
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided.' })
    }
    next()
  })
}
