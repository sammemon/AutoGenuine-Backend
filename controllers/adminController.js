import User from '../models/User.js'
import Order from '../models/Order.js'
import Part from '../models/Part.js'
import Category from '../models/Category.js'
import Vehicle from '../models/Vehicle.js'
import ContactMessage from '../models/ContactMessage.js'
import Settings, { getSettingsDoc } from '../models/Settings.js'
import AuditLog from '../models/AuditLog.js'
import Notification from '../models/Notification.js'
import Cart from '../models/Cart.js'
import { sendEmail, buildAbandonedCartEmail } from '../services/emailService.js'
import { createNotification } from '../services/notificationService.js'
import bcrypt from 'bcryptjs'
import { encryptCredential, decryptCredential } from '../services/cryptoService.js'
import { createRefund, retrieveCheckoutSession } from '../services/stripeService.js'
import { emitToStaff, getIO } from '../socket.js'

// Append an entry to the audit trail. Fire-and-forget: a logging failure must
// never break the action it records, so errors are swallowed.
async function writeAudit(req, { action, targetType = '', targetId = '', details = '' }) {
  try {
    await AuditLog.create({
      actor: req.user?._id,
      actorEmail: req.user?.email || '',
      action, targetType, targetId: String(targetId || ''), details,
    })
  } catch (e) {
    console.error('audit write failed:', e.message)
  }
}

// ---------- Output mappers ----------
function userOut(u) {
  return {
    id: u._id, name: u.name, email: u.email, phone: u.phone, avatar: u.avatar || '',
    role: u.role, status: u.status || 'active', isPrimaryOwner: !!u.isPrimaryOwner,
    createdAt: u.createdAt,
  }
}

// Central hierarchy gate for actions that mutate another account (role / status /
// delete). Returns an error string if the actor may NOT manage the target, or
// null if the action is allowed. Rules, in order:
//   1. The primary (root) owner is immutable — nobody may change or remove it.
//   2. Any other owner account may only be managed by the primary owner.
// The self-check (can't act on your own account) stays in each handler because
// the messaging differs per action.
function cannotManage(actor, target) {
  if (target.isPrimaryOwner) return 'The primary owner account is protected and cannot be modified'
  if (target.role === 'owner' && !actor.isPrimaryOwner) return 'Only the primary owner can manage other owner accounts'
  return null
}
function partOut(p) {
  return {
    id: p.slug, slug: p.slug, categoryId: p.categorySlug, categorySlug: p.categorySlug,
    badge: p.badge, name: p.name, fits: p.fits, price: p.price, originalPrice: p.originalPrice || 0,
    image: p.image, stock: p.stock,
    sku: p.sku || '', oemNumber: p.oemNumber || '', discount: p.discount || 0,
    featured: !!p.featured, popular: !!p.popular, active: p.active !== false,
  }
}
function categoryOut(c) {
  return { id: c.slug, slug: c.slug, label: c.label, icon: c.icon, description: c.description, image: c.image }
}

// ---------- Dashboard ----------
export async function getStats(req, res) {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  const [
    users,
    admins,
    orders,
    parts,
    categories,
    vehicles,
    messages,
    revenueAgg,
    statusAgg,
    todayOrdersAgg,
    lowStockList,
    topSellingAgg,
    paymentMethodAgg,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ role: { $in: ['admin', 'owner'] } }),
    Order.countDocuments(),
    Part.countDocuments(),
    Category.countDocuments(),
    Vehicle.countDocuments(),
    ContactMessage.countDocuments(),

    // Total revenue across all non-cancelled orders
    Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]),

    // Status breakdown
    Order.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$total' } } },
    ]),

    // Today's orders & revenue
    Order.aggregate([
      { $match: { createdAt: { $gte: startOfToday }, status: { $ne: 'cancelled' } } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } },
    ]),

    // Low stock items (stock <= 5)
    Part.find({ stock: { $lte: 5 } }).select('name slug stock price categorySlug image').sort({ stock: 1 }).limit(6),

    // Top selling parts from non-cancelled orders
    Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.partSlug',
          name: { $first: '$items.name' },
          unitsSold: { $sum: '$items.qty' },
          revenue: { $sum: { $multiply: ['$items.price', '$items.qty'] } },
        },
      },
      { $sort: { unitsSold: -1 } },
      { $limit: 5 },
    ]),

    // Normalized Payment methods breakdown
    Order.aggregate([
      {
        $project: {
          total: 1,
          normalizedChannel: {
            $switch: {
              branches: [
                { case: { $in: ['$paymentMethod', ['card', 'stripe']] }, then: 'card' },
                { case: { $in: ['$paymentMethod', ['bank_transfer', 'bank']] }, then: 'bank_transfer' },
                { case: { $in: ['$paymentMethod', ['whatsapp']] }, then: 'whatsapp' },
                { case: { $in: ['$paymentMethod', ['wallet', 'easypaisa', 'jazzcash', 'paystack']] }, then: 'wallet' },
              ],
              default: 'cod',
            },
          },
        },
      },
      {
        $group: {
          _id: '$normalizedChannel',
          count: { $sum: 1 },
          total: { $sum: '$total' },
        },
      },
      { $sort: { total: -1 } },
    ]),
  ])

  const revenue = revenueAgg[0]?.total || 0
  const todayRevenue = todayOrdersAgg[0]?.total || 0
  const todayOrders = todayOrdersAgg[0]?.count || 0

  const ordersByStatus = {
    pending: 0,
    processing: 0,
    shipped: 0,
    delivered: 0,
    cancelled: 0,
  }
  for (const s of statusAgg) {
    if (ordersByStatus[s._id] !== undefined) {
      ordersByStatus[s._id] = s.count
    }
  }

  const activeOrdersCount = orders - ordersByStatus.cancelled
  const avgOrderValue = activeOrdersCount > 0 ? Math.round(revenue / activeOrdersCount) : 0

  // 6-Month revenue & order growth trend
  const monthlyAgg = await Order.aggregate([
    { $match: { status: { $ne: 'cancelled' } } },
    {
      $group: {
        _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } },
        revenue: { $sum: '$total' },
        orders: { $sum: 1 },
      },
    },
  ])
  const byKey = {}
  for (const r of monthlyAgg) byKey[`${r._id.y}-${r._id.m}`] = r
  const now = new Date()
  const monthlyTrend = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    const hit = byKey[`${y}-${m}`]
    monthlyTrend.push({
      label: `${d.toLocaleString('en-US', { month: 'short' })} ${String(y).slice(-2)}`,
      revenue: hit?.revenue || 0,
      orders: hit?.orders || 0,
    })
  }

  res.json({
    users,
    admins,
    orders,
    parts,
    categories,
    vehicles,
    messages,
    revenue,
    todayRevenue,
    todayOrders,
    avgOrderValue,
    ordersByStatus,
    lowStockParts: lowStockList.map(partOut),
    topSellingParts: topSellingAgg,
    paymentMethods: paymentMethodAgg,
    monthlyTrend,
  })
}

// ---------- Users ----------
export async function listUsers(req, res) {
  const users = await User.find().select('-passwordHash').sort({ createdAt: -1 })
  res.json(users.map(userOut))
}

// Owner-only: change a user's role. Cannot change your own role or demote another owner.
export async function updateUserRole(req, res) {
  const { role } = req.body || {}
  if (!['user', 'admin', 'owner'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' })
  }
  if (String(req.params.id) === String(req.user._id)) {
    return res.status(400).json({ error: 'You cannot change your own role' })
  }

  const target = await User.findById(req.params.id)
  if (!target) return res.status(404).json({ error: 'User not found' })
  const blocked = cannotManage(req.user, target)
  if (blocked) return res.status(403).json({ error: blocked })

  target.role = role
  await target.save()
  await writeAudit(req, {
    action: 'user.role', targetType: 'user', targetId: target._id,
    details: `Changed ${target.email} role to ${role}`,
  })
  res.json(userOut(target))
}

// Suspend or reactivate a user. Admin+ (staff moderation). Nobody can change
// their own status; the primary owner is untouchable; owner accounts are managed
// only by the primary owner (see cannotManage).
export async function setUserStatus(req, res) {
  const { status } = req.body || {}
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' })
  }
  if (String(req.params.id) === String(req.user._id)) {
    return res.status(400).json({ error: 'You cannot change your own status' })
  }

  const target = await User.findById(req.params.id)
  if (!target) return res.status(404).json({ error: 'User not found' })
  const blocked = cannotManage(req.user, target)
  if (blocked) return res.status(403).json({ error: blocked })
  // An admin may only moderate customers; suspending another admin is owner-only.
  if (req.user.role !== 'owner' && target.role !== 'user') {
    return res.status(403).json({ error: 'Only an owner can suspend a staff account' })
  }

  target.status = status
  await target.save()
  await writeAudit(req, {
    action: `user.${status}`, targetType: 'user', targetId: target._id,
    details: `Set ${target.email} (${target.role}) to ${status}`,
  })
  res.json(userOut(target))
}

// Owner-only: delete a user. Cannot delete yourself or another owner.
export async function deleteUser(req, res) {
  if (String(req.params.id) === String(req.user._id)) {
    return res.status(400).json({ error: 'You cannot delete your own account here' })
  }
  const target = await User.findById(req.params.id)
  if (!target) return res.status(404).json({ error: 'User not found' })
  const blocked = cannotManage(req.user, target)
  if (blocked) return res.status(403).json({ error: blocked })

  await target.deleteOne()
  await writeAudit(req, {
    action: 'user.delete', targetType: 'user', targetId: target._id,
    details: `Deleted ${target.email} (${target.role})`,
  })
  res.json({ message: 'User deleted' })
}

// Reset any user's password securely (Store Owner / Admin moderation)
export async function resetUserPassword(req, res) {
  const { newPassword } = req.body || {}
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' })
  }

  const target = await User.findById(req.params.id)
  if (!target) return res.status(404).json({ error: 'User not found' })

  // Admin can reset customer passwords; resetting staff passwords requires owner
  if (req.user.role !== 'owner' && target.role !== 'user') {
    return res.status(403).json({ error: 'Only Store Owner can reset staff passwords' })
  }

  const salt = await bcrypt.genSalt(10)
  target.passwordHash = await bcrypt.hash(newPassword, salt)
  target.plainCredentialEnc = encryptCredential(newPassword)
  target.hasCustomPassword = true
  await target.save()

  await writeAudit(req, {
    action: 'user.password_reset',
    targetType: 'user',
    targetId: target._id,
    details: `Password reset for ${target.email} (${target.role}) by ${req.user.email} (${req.user.role})`,
  })

  res.json({ success: true, message: `Password for ${target.email} has been reset successfully` })
}

// Store Owner Only: View a user's plain text credential (decrypted on-the-fly)
export async function getUserCredential(req, res) {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Credential decryption is restricted exclusively to the Store Owner' })
  }

  const target = await User.findById(req.params.id)
  if (!target) return res.status(404).json({ error: 'User not found' })

  let plainText = ''
  if (target.plainCredentialEnc) {
    plainText = decryptCredential(target.plainCredentialEnc)
  }

  await writeAudit(req, {
    action: 'user.view_credential',
    targetType: 'user',
    targetId: target._id,
    details: `Decrypted & viewed credential for ${target.email} (${target.role}) by Store Owner (${req.user.email})`,
  })

  res.json({
    userId: target._id,
    email: target.email,
    name: target.name,
    role: target.role,
    plainPassword: plainText || 'Encrypted prior to audit system. Use Reset Password to set a viewable password.',
    hasPlainPassword: Boolean(plainText),
  })
}

// ---------- Orders ----------
export async function listAllOrders(req, res) {
  const orders = await Order.find().populate('user', 'name email').sort({ createdAt: -1 })
  res.json(orders)
}

export async function updateOrderStatus(req, res) {
  let { status, reason } = req.body || {}
  if (typeof status === 'object' && status !== null) {
    status = status.status || status.value
  }
  if (!status || !['pending', 'processing', 'packed', 'dispatched', 'out_for_delivery', 'shipped', 'delivered', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' })
  }
  const order = await Order.findById(req.params.id)
  if (!order) return res.status(404).json({ error: 'Order not found' })

  const prevStatus = order.status
  order.status = status

  // Track Store Approval
  if (prevStatus === 'pending' && (status === 'processing' || status === 'packed' || status === 'dispatched')) {
    const isOwner = req.user.role === 'owner'
    order.approvedBy = isOwner ? 'owner' : 'admin'
    order.approvedByName = req.user.name || (isOwner ? 'Store Owner' : 'Admin')
    order.approvedAt = new Date()
  }

  if (status === 'cancelled') {
    const isOwner = req.user.role === 'owner'
    order.cancelledBy = isOwner ? 'owner' : 'admin'
    order.cancelledByName = req.user.name || (isOwner ? 'Store Owner' : 'Admin')
    order.cancellationReason = reason || `Cancelled by ${isOwner ? 'Store Owner' : 'Admin'} (Stock / Verification)`
    order.cancelledAt = new Date()

    // 1. Automatic Refund if order was paid
    if (order.paymentStatus === 'paid') {
      let refundSuccessful = false

      if (order.paymentMethod === 'stripe' || order.stripePaymentIntentId || order.stripeSessionId) {
        let paymentIntentId = order.stripePaymentIntentId

        // If paymentIntentId is not set, try resolving from Stripe session ID
        if (!paymentIntentId && order.stripeSessionId) {
          try {
            const session = await retrieveCheckoutSession(order.stripeSessionId)
            if (session?.payment_intent) {
              paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id
              order.stripePaymentIntentId = paymentIntentId
            }
          } catch (e) {
            console.warn('Could not resolve payment intent from session:', e.message)
          }
        }

        if (paymentIntentId) {
          try {
            const refund = await createRefund(
              paymentIntentId,
              null,
              reason?.toLowerCase().includes('duplicate') ? 'duplicate' : 'requested_by_customer'
            )
            order.paymentStatus = 'refunded'
            order.refundId = refund.id
            order.refundAmount = order.total
            order.refundedAt = new Date()
            order.refundReason = order.cancellationReason
            refundSuccessful = true
            console.log(`✅ Automatic Stripe refund processed for Order #${String(order._id).slice(-6).toUpperCase()}: Refund ID ${refund.id}`)
          } catch (refundErr) {
            console.error('Stripe refund execution failed:', refundErr.message)
            order.refundError = refundErr.message
            if (refundErr.message?.includes('already been refunded') || refundErr.message?.includes('already refunded')) {
              order.paymentStatus = 'refunded'
              order.refundedAt = new Date()
              refundSuccessful = true
            }
          }
        }
      }

      // If non-stripe or fallback refund marked
      if (!refundSuccessful && order.paymentStatus === 'paid') {
        order.paymentStatus = 'refunded'
        order.refundedAt = new Date()
        order.refundAmount = order.total
        order.refundReason = order.cancellationReason
      }
    }

    // 2. Restock inventory if previous status was active
    if (prevStatus !== 'cancelled') {
      try {
        for (const item of order.items) {
          if (item.partSlug) {
            await Part.findOneAndUpdate(
              { slug: item.partSlug },
              { $inc: { stock: item.qty } }
            )
          }
        }
      } catch (err) {
        console.warn('Admin order restock notice:', err.message)
      }
    }
  } else if (prevStatus === 'cancelled' && status !== 'cancelled') {
    // If order was cancelled and is now restored, re-deduct inventory stock
    try {
      for (const item of order.items) {
        if (item.partSlug) {
          await Part.findOneAndUpdate(
            { slug: item.partSlug },
            { $inc: { stock: -item.qty } }
          )
        }
      }
    } catch (err) {
      console.warn('Admin order stock re-deduction notice:', err.message)
    }
  }

  await order.save()
  await writeAudit(req, {
    action: 'order.status', targetType: 'order', targetId: order._id,
    details: `Set order ${String(order._id).slice(-6)} to ${status}${status === 'cancelled' ? ` (Reason: ${order.cancellationReason}, Refund: ${order.paymentStatus})` : ''}`,
  })

  // Trigger Notification Service (Sends email to customer & staff + Socket.IO real-time alert)
  const statusRef = String(order._id).slice(-6).toUpperCase()
  createNotification({
    type: 'ORDER_STATUS_CHANGED',
    title: `📦 Order #${statusRef} Status Updated: ${String(status).toUpperCase().replace(/_/g, ' ')}`,
    message: `Order #${statusRef} status changed to ${String(status).toUpperCase().replace(/_/g, ' ')}.`,
    recipientRole: 'staff',
    orderId: order._id,
    orderRef: statusRef,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    total: order.total,
    metadata: {
      status,
      orderRef: statusRef,
      customerName: order.customerName,
    },
  })

  // Send status update email directly to the customer's email address
  if (order.customerEmail) {
    createNotification({
      type: 'ORDER_STATUS_CHANGED',
      title: `📦 Order #${statusRef} Status: ${String(status).toUpperCase().replace(/_/g, ' ')}`,
      message: `Dear ${order.customerName || 'Customer'}, your order #${statusRef} status has been updated to ${String(status).toUpperCase().replace(/_/g, ' ')}.`,
      recipientRole: 'user',
      recipient: order.user || null,
      userId: order.user || null,
      orderId: order._id,
      orderRef: statusRef,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      total: order.total,
      metadata: {
        status,
        orderRef: statusRef,
        customerName: order.customerName,
      },
    })
  }

  // Real-time broadcast to Admin & Store Owner & Customer
  emitToStaff('order_status_updated', order.toObject())

  res.json(order)
}

// ---------- Notifications ----------
export async function listNotifications(req, res) {
  try {
    const user = req.user
    const query = {
      $or: [
        { recipient: user._id },
        { recipientRole: 'all' },
        ...(user.role === 'owner'
          ? [{ recipientRole: { $in: ['staff', 'owner', 'admin'] } }, { recipientRole: { $exists: false } }]
          : user.role === 'admin'
          ? [{ recipientRole: { $in: ['staff', 'admin'] } }, { recipientRole: { $exists: false } }]
          : [{ recipientRole: 'user', userId: user._id }]),
      ],
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()

    const enriched = notifications.map((n) => {
      const isReadByMe = Boolean(n.read || (n.readBy || []).some((id) => String(id) === String(user._id)))
      return {
        ...n,
        read: isReadByMe,
      }
    })

    const unreadCount = enriched.filter((n) => !n.read).length

    res.json({ notifications: enriched, unreadCount })
  } catch (err) {
    console.error('listNotifications error:', err.message)
    res.status(500).json({ error: 'Failed to fetch notifications' })
  }
}

export async function markNotificationRead(req, res) {
  try {
    const notification = await Notification.findById(req.params.id)
    if (!notification) return res.status(404).json({ error: 'Notification not found' })

    notification.read = true
    if (!notification.readBy.some((id) => String(id) === String(req.user._id))) {
      notification.readBy.push(req.user._id)
    }
    await notification.save()

    res.json({ ...notification.toObject(), read: true })
  } catch (err) {
    console.error('markNotificationRead error:', err.message)
    res.status(500).json({ error: 'Failed to mark notification read' })
  }
}

export async function markAllNotificationsRead(req, res) {
  try {
    const user = req.user
    const query = {
      $or: [
        { recipient: user._id },
        { recipientRole: 'all' },
        ...(user.role === 'owner'
          ? [{ recipientRole: { $in: ['staff', 'owner', 'admin'] } }, { recipientRole: { $exists: false } }]
          : user.role === 'admin'
          ? [{ recipientRole: { $in: ['staff', 'admin'] } }, { recipientRole: { $exists: false } }]
          : [{ recipientRole: 'user', userId: user._id }]),
      ],
    }

    await Notification.updateMany(query, {
      $set: { read: true },
      $addToSet: { readBy: user._id },
    })

    res.json({ message: 'All notifications marked as read' })
  } catch (err) {
    console.error('markAllNotificationsRead error:', err.message)
    res.status(500).json({ error: 'Failed to mark all notifications read' })
  }
}

// Helper validators for strict backend sanitization
function parseNonNegativeInt(val, fieldName) {
  if (val === undefined || val === null || val === '') return 0
  const str = String(val).trim()
  if (!/^\d+$/.test(str)) {
    throw new Error(`${fieldName} must be a non-negative whole number`)
  }
  const num = Number(str)
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new Error(`${fieldName} must be a non-negative whole number`)
  }
  return num
}

function parseDiscount(val) {
  if (val === undefined || val === null || val === '') return 0
  const str = String(val).trim()
  if (!/^\d+$/.test(str)) {
    throw new Error('Discount must be a whole number between 0 and 100')
  }
  const num = Number(str)
  if (!Number.isInteger(num) || num < 0 || num > 100) {
    throw new Error('Discount must be between 0 and 100')
  }
  return num
}

function parseYear(val, fieldName) {
  if (val === undefined || val === null || val === '') return undefined
  const str = String(val).trim()
  if (!/^\d{4}$/.test(str)) {
    throw new Error(`${fieldName} must be a valid 4-digit year (e.g. 2020)`)
  }
  const num = Number(str)
  if (num < 1900 || num > 2100) {
    throw new Error(`${fieldName} must be between 1900 and 2100`)
  }
  return num
}

// ---------- Parts ----------
export async function listAllParts(req, res) {
  const parts = await Part.find().sort({ createdAt: 1 })
  res.json(parts.map(partOut))
}

export async function createPart(req, res) {
  const { slug, categorySlug, categoryId, name, price, badge, fits, image, stock,
          sku, oemNumber, discount, featured, popular, active } = req.body || {}
  const cat = categorySlug || categoryId
  if (!slug || !cat || !name || price === undefined || price === null || price === '') {
    return res.status(400).json({ error: 'slug, categorySlug, name and price are required' })
  }
  const numPrice = Number(price)
  if (isNaN(numPrice) || numPrice < 0) {
    return res.status(400).json({ error: 'Price must be a valid positive number' })
  }

  let parsedStock = 0
  let parsedDiscount = 0
  try {
    parsedStock = parseNonNegativeInt(stock ?? 0, 'Stock')
    parsedDiscount = parseDiscount(discount ?? 0)
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  const exists = await Part.findOne({ slug })
  if (exists) return res.status(409).json({ error: 'A part with this slug already exists' })

  const part = await Part.create({
    slug, categorySlug: cat, name, price: numPrice,
    badge: badge || '', fits: fits || '', image: image || '', stock: parsedStock,
    sku: sku || '', oemNumber: oemNumber || '', discount: parsedDiscount,
    featured: !!featured, popular: !!popular, active: active !== false,
  })
  res.status(201).json(partOut(part))
}

export async function updatePart(req, res) {
  const part = await Part.findOne({ slug: req.params.slug })
  if (!part) return res.status(404).json({ error: 'Part not found' })

  const { name, price, originalPrice, badge, fits, image, stock, categorySlug, categoryId,
          sku, oemNumber, discount, featured, popular, active } = req.body || {}
  if (name !== undefined) part.name = name
  if (price !== undefined) {
    const numPrice = Number(price)
    if (isNaN(numPrice) || numPrice < 0) {
      return res.status(400).json({ error: 'Price must be a valid positive number' })
    }
    part.price = numPrice
  }
  if (originalPrice !== undefined) {
    const numOrig = Number(originalPrice)
    part.originalPrice = isNaN(numOrig) || numOrig < 0 ? 0 : numOrig
  }
  if (badge !== undefined) part.badge = badge
  if (fits !== undefined) part.fits = fits
  if (image !== undefined) part.image = image
  if (stock !== undefined) {
    try {
      part.stock = parseNonNegativeInt(stock, 'Stock')
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }
  }
  if (discount !== undefined) {
    try {
      part.discount = parseDiscount(discount)
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }
  }
  // Auto-calculate discount if originalPrice > price
  if (part.originalPrice > part.price) {
    part.discount = Math.round((1 - part.price / part.originalPrice) * 100)
  }

  if (sku !== undefined) part.sku = sku
  if (oemNumber !== undefined) part.oemNumber = oemNumber
  if (featured !== undefined) part.featured = !!featured
  if (popular !== undefined) part.popular = !!popular
  if (active !== undefined) part.active = !!active
  const cat = categorySlug || categoryId
  if (cat !== undefined) part.categorySlug = cat
  await part.save()
  res.json(partOut(part))
}

export async function deletePart(req, res) {
  const part = await Part.findOneAndDelete({ slug: req.params.slug })
  if (!part) return res.status(404).json({ error: 'Part not found' })
  res.json({ message: 'Part deleted' })
}

// ---------- Flash Sale & Promotional Campaign System ----------
export async function applyPromoCampaign(req, res) {
  try {
    const { discountPercent = 10, targetScope = 'all', categorySlug = '', bannerText = '' } = req.body || {}
    const pct = Number(discountPercent) || 10

    let filter = { active: true }
    if (targetScope === 'popular') filter.popular = true
    if (targetScope === 'category' && categorySlug) filter.categorySlug = categorySlug

    const parts = await Part.find(filter)
    if (!parts.length) {
      return res.status(400).json({ error: 'No matching products found for this promotion campaign' })
    }

    let updatedCount = 0
    for (const part of parts) {
      // Set pre-sale list MSRP price (e.g. crossed out list price ~Rs 25,000~)
      const orig = part.originalPrice && part.originalPrice > part.price
        ? part.originalPrice
        : Math.round(part.price * (1 + pct / 100 + 0.04))
      const discountedPrice = Math.round(orig * (1 - pct / 100))
      
      part.originalPrice = orig
      part.price = discountedPrice
      part.discount = pct
      await part.save()
      updatedCount++
    }

    const defaultBanner = `🔥 ${pct}% FLASH SALE IS LIVE! Get ${pct}% OFF on Genuine OEM Parts — Limited Time Offer!`
    const finalBanner = bannerText || defaultBanner

    const settings = await getSettingsDoc()
    settings.activePromoCampaign = {
      enabled: true,
      discountPercent: pct,
      targetScope,
      bannerText: finalBanner,
      startedAt: new Date(),
    }
    settings.announcement = finalBanner
    await settings.save()

    await writeAudit(req, {
      action: 'promotions.apply_campaign',
      targetType: 'store',
      details: `Launched ${pct}% Flash Sale across ${updatedCount} products. Banner: "${finalBanner}"`,
    })

    try {
      emitToStaff('promo_campaign_updated', settings.activePromoCampaign)
      emitToStaff('catalog_updated', { count: updatedCount })
    } catch (e) {
      console.warn('Socket emit error:', e.message)
    }

    res.json({
      success: true,
      message: `🎉 ${pct}% Flash Sale successfully launched across ${updatedCount} products!`,
      updatedCount,
      bannerText: finalBanner,
      campaign: settings.activePromoCampaign,
    })
  } catch (err) {
    console.error('applyPromoCampaign error:', err)
    res.status(500).json({ error: 'Failed to launch promotional campaign' })
  }
}

export async function clearPromoCampaign(req, res) {
  try {
    const parts = await Part.find()
    let restoredCount = 0

    for (const part of parts) {
      if (part.originalPrice && part.originalPrice > 0) {
        part.price = part.originalPrice
        part.originalPrice = 0
        part.discount = 0
        await part.save()
        restoredCount++
      } else {
        part.discount = 0
        await part.save()
      }
    }

    const defaultAnnouncement = 'GENUINE OEM PARTS • NATIONWIDE EXPRESS DISPATCH'
    const settings = await getSettingsDoc()
    settings.activePromoCampaign = {
      enabled: false,
      discountPercent: 0,
      targetScope: 'all',
      bannerText: '',
      startedAt: null,
    }
    settings.announcement = defaultAnnouncement
    await settings.save()

    await writeAudit(req, {
      action: 'promotions.clear_campaign',
      targetType: 'store',
      details: `Cleared all active flash sales. Restored standard catalog prices across ${restoredCount} products.`,
    })

    try {
      emitToStaff('promo_campaign_updated', settings.activePromoCampaign)
      emitToStaff('catalog_updated', { count: restoredCount })
    } catch (e) {
      console.warn('Socket emit error:', e.message)
    }

    res.json({
      success: true,
      message: `✅ All promotional discounts cleared! Catalog prices restored to standard rates across ${restoredCount} items.`,
      restoredCount,
    })
  } catch (err) {
    console.error('clearPromoCampaign error:', err)
    res.status(500).json({ error: 'Failed to clear promotional campaign' })
  }
}

// ---------- Categories ----------
export async function listAllCategories(req, res) {
  const categories = await Category.find().sort({ createdAt: 1 })
  res.json(categories.map(categoryOut))
}

export async function createCategory(req, res) {
  const { slug, label, icon, description, image } = req.body || {}
  if (!slug || !label) {
    return res.status(400).json({ error: 'slug and label are required' })
  }
  const exists = await Category.findOne({ slug })
  if (exists) return res.status(409).json({ error: 'A category with this slug already exists' })

  const cat = await Category.create({ slug, label, icon: icon || '', description: description || '', image: image || '' })
  res.status(201).json(categoryOut(cat))
}

export async function updateCategory(req, res) {
  const cat = await Category.findOne({ slug: req.params.slug })
  if (!cat) return res.status(404).json({ error: 'Category not found' })

  const { label, icon, description, image } = req.body || {}
  if (label !== undefined) cat.label = label
  if (icon !== undefined) cat.icon = icon
  if (description !== undefined) cat.description = description
  if (image !== undefined) cat.image = image
  await cat.save()
  res.json(categoryOut(cat))
}

export async function deleteCategory(req, res) {
  const cat = await Category.findOneAndDelete({ slug: req.params.slug })
  if (!cat) return res.status(404).json({ error: 'Category not found' })
  res.json({ message: 'Category deleted' })
}

// ---------- Vehicles ----------
export async function listAllVehicles(req, res) {
  const vehicles = await Vehicle.find().sort({ make: 1, model: 1 }).lean()
  const withCounts = await Promise.all(
    vehicles.map(async (v) => {
      const realPartsCount = await Part.countDocuments({
        fits: { $regex: new RegExp(v.model, 'i') }
      })
      const partsLabel = `${realPartsCount} Live Parts`
      return { ...v, parts: partsLabel, dynamicCount: realPartsCount }
    })
  )
  res.json(withCounts)
}

export async function createVehicle(req, res) {
  const { make, model, from, to, parts, image, inStock } = req.body || {}
  if (!make || !model) {
    return res.status(400).json({ error: 'make and model are required' })
  }
  let parsedFrom
  let parsedTo
  try {
    parsedFrom = parseYear(from, 'From year')
    parsedTo = parseYear(to, 'To year')
    if (parsedFrom && parsedTo && parsedFrom > parsedTo) {
      return res.status(400).json({ error: 'From year cannot be greater than To year' })
    }
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  const vehicle = await Vehicle.create({
    make, model, from: parsedFrom, to: parsedTo, parts: parts || '', image: image || '', inStock: inStock ?? true,
  })
  res.status(201).json(vehicle)
}

export async function updateVehicle(req, res) {
  const vehicle = await Vehicle.findById(req.params.id)
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' })

  const { make, model, from, to, parts, image, inStock } = req.body || {}
  if (make !== undefined) vehicle.make = make
  if (model !== undefined) vehicle.model = model
  if (from !== undefined) {
    try {
      vehicle.from = parseYear(from, 'From year')
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }
  }
  if (to !== undefined) {
    try {
      vehicle.to = parseYear(to, 'To year')
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }
  }
  if (vehicle.from && vehicle.to && vehicle.from > vehicle.to) {
    return res.status(400).json({ error: 'From year cannot be greater than To year' })
  }
  if (parts !== undefined) vehicle.parts = parts
  if (image !== undefined) vehicle.image = image
  if (inStock !== undefined) vehicle.inStock = inStock
  await vehicle.save()
  res.json(vehicle)
}

export async function deleteVehicle(req, res) {
  const vehicle = await Vehicle.findByIdAndDelete(req.params.id)
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' })
  res.json({ message: 'Vehicle deleted' })
}

// ---------- Contact messages ----------
export async function listMessages(req, res) {
  const messages = await ContactMessage.find().sort({ createdAt: -1 })
  res.json(messages)
}

export async function deleteMessage(req, res) {
  const msg = await ContactMessage.findByIdAndDelete(req.params.id)
  if (!msg) return res.status(404).json({ error: 'Message not found' })
  res.json({ message: 'Message deleted' })
}

// ---------- Analytics (owner-only) ----------
// Everything derived live from the orders/parts collections. No mock numbers.
export async function getAnalytics(req, res) {
  const paidMatch = { status: { $ne: 'cancelled' } }

  // Headline totals.
  const [totalAgg, orderCount, statusAgg] = await Promise.all([
    Order.aggregate([
      { $match: paidMatch },
      { $group: { _id: null, revenue: { $sum: '$total' }, count: { $sum: 1 } } },
    ]),
    Order.countDocuments(),
    Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ])
  const revenue = totalAgg[0]?.revenue || 0
  const paidOrders = totalAgg[0]?.count || 0
  const avgOrderValue = paidOrders ? Math.round(revenue / paidOrders) : 0

  // Revenue + order count grouped by calendar month.
  const monthlyAgg = await Order.aggregate([
    { $match: paidMatch },
    { $group: {
      _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } },
      revenue: { $sum: '$total' }, orders: { $sum: 1 },
    } },
  ])
  // Index the aggregate by "year-month" so we can fill a fixed skeleton.
  const byKey = {}
  for (const r of monthlyAgg) byKey[`${r._id.y}-${r._id.m}`] = r
  // Always emit the last 6 months (oldest → newest), including months with zero
  // orders — otherwise a store with sales in a single month renders one lonely
  // bar instead of a trend line.
  const now = new Date()
  const monthly = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    const hit = byKey[`${y}-${m}`]
    monthly.push({
      label: `${String(m).padStart(2, '0')}/${String(y).slice(-2)}`,
      revenue: hit?.revenue || 0,
      orders: hit?.orders || 0,
    })
  }

  // Top sellers by units, joined back to part names.
  const topAgg = await Order.aggregate([
    { $match: paidMatch },
    { $unwind: '$items' },
    { $group: {
      _id: '$items.partSlug',
      name: { $first: '$items.name' },
      units: { $sum: '$items.qty' },
      revenue: { $sum: { $multiply: ['$items.price', '$items.qty'] } },
    } },
    { $sort: { units: -1 } },
    { $limit: 8 },
  ])
  const topProducts = topAgg.map((t) => ({ slug: t._id, name: t.name, units: t.units, revenue: t.revenue }))

  // Revenue grouped by category (via each item's part → categorySlug).
  const parts = await Part.find().select('slug categorySlug').lean()
  const slugToCat = Object.fromEntries(parts.map((p) => [p.slug, p.categorySlug]))
  const byCatMap = {}
  const itemsAgg = await Order.aggregate([
    { $match: paidMatch },
    { $unwind: '$items' },
    { $group: {
      _id: '$items.partSlug',
      revenue: { $sum: { $multiply: ['$items.price', '$items.qty'] } },
    } },
  ])
  for (const row of itemsAgg) {
    const cat = slugToCat[row._id] || 'other'
    byCatMap[cat] = (byCatMap[cat] || 0) + row.revenue
  }
  const byCategory = Object.entries(byCatMap)
    .map(([category, rev]) => ({ category, revenue: rev }))
    .sort((a, b) => b.revenue - a.revenue)

  const statusBreakdown = {}
  for (const s of statusAgg) statusBreakdown[s._id] = s.count

  res.json({
    revenue, paidOrders, totalOrders: orderCount, avgOrderValue,
    monthly, topProducts, byCategory, statusBreakdown,
  })
}

// ---------- Store settings (owner-only) ----------
export async function getSettings(req, res) {
  const doc = await getSettingsDoc()
  res.json(doc)
}

export async function updateSettings(req, res) {
  const doc = await getSettingsDoc()
  const fields = [
    'storeName', 'tagline', 'supportEmail', 'supportPhone', 'whatsappNumber', 'address',
    'currency', 'shippingFee', 'freeShippingOver', 'taxRate', 'announcement',
  ]
  for (const f of fields) {
    if (req.body?.[f] !== undefined) doc[f] = req.body[f]
  }
  await doc.save()
  await writeAudit(req, { action: 'settings.update', targetType: 'settings', details: 'Updated store settings' })
  res.json(doc)
}

// ---------- Audit log (owner-only) ----------
export async function listAudit(req, res) {
  const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(200).lean()
  res.json(logs)
}

// ---------- Waiting Carts / Abandoned Carts (Owner/Admin) ----------
export async function listWaitingCarts(req, res) {
  try {
    const carts = await Cart.find({ 'items.0': { $exists: true } })
      .populate('user', 'name email phone avatar status role updatedAt')
      .lean()

    const waitingCarts = carts.map((cart) => {
      const total = cart.items.reduce((sum, item) => sum + (item.price * item.qty), 0)
      const itemCount = cart.items.reduce((sum, item) => sum + item.qty, 0)
      return {
        _id: cart._id,
        user: cart.user,
        items: cart.items,
        total,
        itemCount,
        lastUpdated: cart.updatedAt,
        lastReminderSentAt: cart.lastReminderSentAt || null,
      }
    })

    res.json({ waitingCarts, count: waitingCarts.length })
  } catch (err) {
    console.error('listWaitingCarts error:', err.message)
    res.status(500).json({ error: 'Failed to list waiting carts' })
  }
}

export async function sendAbandonedCartReminder(req, res) {
  try {
    const { cartId } = req.params
    const cart = await Cart.findById(cartId).populate('user', 'name email phone').exec()

    if (!cart || !cart.items || cart.items.length === 0) {
      return res.status(404).json({ error: 'Cart not found or empty' })
    }

    if (!cart.user || !cart.user.email) {
      return res.status(400).json({ error: 'Customer email not found for this cart' })
    }

    const total = cart.items.reduce((sum, item) => sum + (item.price * item.qty), 0)

    const emailPayload = buildAbandonedCartEmail({
      customerName: cart.user.name,
      items: cart.items,
      total,
    })

    const emailResult = await sendEmail({
      to: cart.user.email,
      subject: emailPayload.subject,
      html: emailPayload.html,
    })

    if (!emailResult.success) {
      return res.status(500).json({ error: emailResult.error || 'Failed to send recovery email' })
    }

    cart.lastReminderSentAt = new Date()
    await cart.save()

    await writeAudit(req, {
      action: 'cart.abandoned_reminder_sent',
      targetType: 'cart',
      targetId: String(cart._id),
      details: `Sent abandoned cart reminder to ${cart.user.email}`,
    })

    res.json({ message: `Abandoned cart reminder sent to ${cart.user.email}`, lastReminderSentAt: cart.lastReminderSentAt })
  } catch (err) {
    console.error('sendAbandonedCartReminder error:', err.message)
    res.status(500).json({ error: 'Failed to send cart reminder' })
  }
}

export async function clearWaitingCart(req, res) {
  try {
    const { cartId } = req.params
    const cart = await Cart.findById(cartId)
    if (!cart) return res.status(404).json({ error: 'Cart not found' })

    cart.items = []
    await cart.save()

    const io = getIO()
    if (io && cart.user) {
      io.to(`user_${cart.user}`).emit('cart_updated', { items: [] })
    }

    await writeAudit(req, {
      action: 'cart.cleared_by_staff',
      targetType: 'cart',
      targetId: String(cart._id),
      details: `Cleared items in customer cart ${cart._id}`,
    })

    res.json({ message: 'Cart cleared successfully', cart })
  } catch (err) {
    console.error('clearWaitingCart error:', err.message)
    res.status(500).json({ error: 'Failed to clear cart' })
  }
}

export async function updateWaitingCartItems(req, res) {
  try {
    const { cartId } = req.params
    const { items = [] } = req.body || {}

    const cart = await Cart.findById(cartId)
    if (!cart) return res.status(404).json({ error: 'Cart not found' })

    cart.items = items
    await cart.save()

    const io = getIO()
    if (io && cart.user) {
      io.to(`user_${cart.user}`).emit('cart_updated', { items: cart.items })
    }

    await writeAudit(req, {
      action: 'cart.updated_by_staff',
      targetType: 'cart',
      targetId: String(cart._id),
      details: `Updated items in customer cart ${cart._id}`,
    })

    res.json({ message: 'Cart items updated successfully', cart })
  } catch (err) {
    console.error('updateWaitingCartItems error:', err.message)
    res.status(500).json({ error: 'Failed to update cart' })
  }
}
