import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from './config/env.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

import http from 'http'
import express from 'express'
import cors from 'cors'
import { connectDB } from './config/db.js'
import User from './models/User.js'
import { initSocket } from './socket.js'
import authRoutes from './routes/auth.js'
import catalogRoutes from './routes/catalog.js'
import cartRoutes from './routes/cart.js'
import orderRoutes from './routes/orders.js'
import contactRoutes from './routes/contact.js'
import adminRoutes from './routes/admin.js'
import uploadRoutes from './routes/upload.js'
import paymentRoutes from './routes/payments.js'
import chatRoutes from './routes/chat.js'
import { handleStripeWebhook } from './controllers/stripeController.js'
import { requestLogger } from './middleware/logger.js'
import { getSystemStats, renderDashboardHtml } from './dashboard.js'

const app = express()

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://autogenuine.vercel.app',
  process.env.FRONTEND_URL,
].filter(Boolean)

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin) || /\.vercel\.app$/.test(origin)) {
        callback(null, true)
      } else {
        callback(null, true)
      }
    },
    credentials: true,
  })
)

// Stripe Webhook Endpoint MUST receive raw unparsed body for cryptographic signature verification
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook)

app.use(express.json())

// Terminal request logger with ANSI colors
app.use(requestLogger)

// Serve uploaded media statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// Root Dashboard & Health check
app.get('/', (req, res) => {
  res.send(renderDashboardHtml())
})
app.get('/dashboard', (req, res) => res.send(renderDashboardHtml()))

// API Index & Health
app.get('/api', (req, res) => {
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.send(renderDashboardHtml())
  }
  res.json({
    name: 'AutoGenuine API Engine',
    version: '1.0.0',
    status: 'online',
    endpoints: {
      health: '/api/health',
      status: '/api/system/status',
      catalog: {
        parts: '/api/catalog/parts',
        categories: '/api/catalog/categories',
        vehicles: '/api/catalog/vehicles',
      },
      upload: '/api/upload',
      auth: {
        login: '/api/auth/login',
        register: '/api/auth/register',
        me: '/api/auth/me',
      },
      cart: '/api/cart',
      orders: '/api/orders',
      admin: '/api/admin/*',
    },
  })
})
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }))
app.get('/api/system/status', (req, res) => res.json(getSystemStats()))

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/upload', uploadRoutes)
app.use('/api/catalog', catalogRoutes)
app.use('/api/cart', cartRoutes)
app.use('/api/orders', orderRoutes)
app.use('/api/contact', contactRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/payments', paymentRoutes)
app.use('/api/chat', chatRoutes)

// 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))

// Central error handler
app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
})

import { startAutoPilotScheduler } from './services/autoPilotService.js'

const PORT = process.env.PORT || 5000

const httpServer = http.createServer(app)
initSocket(httpServer)

connectDB(process.env.MONGODB_URI || 'mongodb://localhost:27017/autogenuine').then(async () => {
  try {
    const ownerEmail = (process.env.OWNER_EMAIL || 'OwnerAutogenuine@gmail.com').toLowerCase().trim()
    const adminEmail = (process.env.ADMIN_EMAIL || 'adminautogenuine@gmail.com').toLowerCase().trim()

    await User.updateMany(
      { email: { $in: ['owner@autogenuine.com', 'owner@example.com'] } },
      { email: ownerEmail }
    )
    await User.updateMany(
      { email: { $in: ['admin@autogenuine.com', 'admin@example.com'] } },
      { email: adminEmail }
    )
  } catch (err) {
    console.warn('⚠️ User email migration notice:', err.message)
  }

  httpServer.listen(PORT, () => {
    console.log(`✓ Server & Socket.io running on http://localhost:${PORT}`)
    startAutoPilotScheduler()
  })
})
