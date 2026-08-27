import Settings, { getSettingsDoc } from '../models/Settings.js'
import Order from '../models/Order.js'
import Part from '../models/Part.js'
import AuditLog from '../models/AuditLog.js'
import { emitToStaff } from '../socket.js'
import { createNotification } from './notificationService.js'

/**
 * Realistic Fulfillment Time Thresholds
 * Realistic Mode uses real-world warehouse & courier hours.
 * Fast Mode allows instant demonstration for testing.
 */
const TIMELINES = {
  realistic: {
    packedAfterHours: 4,         // 4-5 hours: Quality inspected & boxed
    dispatchAfterHours: 10,      // 10-12 hours: Evening warehouse courier handover
    transitAfterHours: 24,       // 24 hours: Arrived at TCS / Logistics Sorting Hub
    outForDeliveryHours: 48,     // 48 hours (Day 2-3): Courier rider out for delivery
    deliveredAfterHours: 72,     // 72-84 hours: Safely delivered & signed
  },
  fast: {
    packedAfterHours: 0.033,     // ~2 minutes
    dispatchAfterHours: 0.083,   // ~5 minutes
    transitAfterHours: 0.166,    // ~10 minutes
    outForDeliveryHours: 0.25,   // ~15 minutes
    deliveredAfterHours: 0.333,  // ~20 minutes
  },
}

/**
 * Real-time Instant Order Processor for Auto-Pilot
 * When an order is placed, it confirms the order & moves to 'processing' (0 hours).
 * It does NOT jump immediately to dispatched — subsequent phases follow realistic warehouse schedules.
 */
export async function processOrderWithAutoPilot(orderId) {
  try {
    if (!orderId) return
    const settings = await getSettingsDoc()
    const autoPilot = settings.autoPilot || {}

    // Strictly check if Auto-Pilot is enabled by Store Owner/Admin
    if (!autoPilot.enabled) return

    const order = await Order.findById(orderId)
    if (!order || order.status !== 'pending') return

    // Require Stripe Payment Verification
    const isStripeOrCard = order.paymentMethod === 'stripe' || order.paymentMethod === 'card' || order.paymentMethod === 'online'
    if (isStripeOrCard && order.paymentStatus !== 'paid') {
      console.log(`[Auto-Pilot] Order #${order._id.toString().slice(-6).toUpperCase()} is unpaid Stripe order (paymentStatus: ${order.paymentStatus}). Paused until payment verification.`)
      return
    }

    const maxVal = autoPilot.maxAutoOrderValue || 250000
    if (order.total > maxVal) {
      console.log(`[Auto-Pilot] Order #${order._id.toString().slice(-6).toUpperCase()} exceeds limit (Rs ${maxVal}). Paused for owner review.`)
      return
    }

    const now = new Date()
    const logs = []

    // Phase 1: Immediate Order Confirmation (pending -> processing)
    if (autoPilot.autoConfirmOrders) {
      order.status = 'processing'
      order.notes =
        (order.notes ? `${order.notes}\n` : '') +
        `[Auto-Pilot]: Order verified & stock reserved. Sent to warehouse for inspection & packing at ${now.toLocaleTimeString()}`

      await order.save()

      const logEntry = {
        action: 'Order Verified & Approved',
        details: `Order #${order._id.toString().slice(-6).toUpperCase()} (${order.customerName}, Rs ${order.total.toLocaleString()}) confirmed and queued for warehouse packing.`,
        timestamp: now,
      }
      logs.push(logEntry)

      await AuditLog.create({
        action: 'autopilot.order_confirm',
        targetType: 'order',
        targetId: order._id.toString(),
        details: logEntry.details,
        aiGenerated: true,
        userConfirmed: true,
      })

      settings.autoPilot.lastRunAt = now
      if (!settings.autoPilot.logs) settings.autoPilot.logs = []
      settings.autoPilot.logs.unshift(...logs)
      if (settings.autoPilot.logs.length > 50) {
        settings.autoPilot.logs = settings.autoPilot.logs.slice(0, 50)
      }
      await settings.save()

      try {
        emitToStaff('autopilot_cycle_completed', { actionsCount: logs.length, logs, timestamp: now, orderId: order._id })
        emitToStaff('order_updated', order.toObject())
      } catch (e) {
        console.warn('Socket broadcast warning:', e.message)
      }

      console.log(`✓ [Auto-Pilot] Order #${order._id.toString().slice(-6).toUpperCase()} confirmed -> Processing (Packing stage will follow in ~4-5h)`)
    }
  } catch (err) {
    console.error('processOrderWithAutoPilot error:', err)
  }
}

/**
 * Autonomous Store Operations Engine (Sweeps background queue with realistic time gaps)
 */
export async function runAutoPilotCycle() {
  try {
    const settings = await getSettingsDoc()
    const autoPilot = settings.autoPilot || {}
    const minThreshold = autoPilot.minPendingThreshold || 10

    const pendingCount = await Order.countDocuments({ status: 'pending' })
    const isAwayModeTriggered = autoPilot.awayModeEnabled && pendingCount >= minThreshold

    if (!autoPilot.enabled && !isAwayModeTriggered) {
      return { active: false, message: 'Auto-Pilot mode is currently disabled.' }
    }

    const mode = autoPilot.speedMode === 'fast' ? 'fast' : 'realistic'
    const limits = TIMELINES[mode]
    const logs = []
    const now = new Date()

    // 1. Check Pending Orders -> Move to Processing
    if (autoPilot.autoConfirmOrders || isAwayModeTriggered) {
      const maxVal = autoPilot.maxAutoOrderValue || 250000
      const pendingOrders = await Order.find({ status: 'pending', total: { $lte: maxVal } }).limit(20)

      if (pendingOrders.length > 0) {
        for (const order of pendingOrders) {
          // Require Stripe Payment Verification
          const isStripeOrCard = order.paymentMethod === 'stripe' || order.paymentMethod === 'card' || order.paymentMethod === 'online'
          if (isStripeOrCard && order.paymentStatus !== 'paid') {
            console.log(`[Auto-Pilot Sweep] Skipping Order #${order._id.toString().slice(-6).toUpperCase()} — Stripe payment unverified (${order.paymentStatus}).`)
            continue
          }

          order.status = 'processing'
          order.notes =
            (order.notes ? `${order.notes}\n` : '') +
            `[Auto-Pilot ${isAwayModeTriggered ? 'Away Mode' : 'Worker'}]: Verified & moved to Processing at ${now.toLocaleTimeString()}`
          await order.save()

          logs.push({
            action: isAwayModeTriggered ? 'Away Mode: Order Moved to Processing' : 'Order Confirmed & Processing',
            details: `Order #${order._id.toString().slice(-6).toUpperCase()} auto-confirmed. Queued for warehouse inspection.`,
            timestamp: now,
          })
        }

        // Notify Store Owner & Admins via email & real-time notification
        if (isAwayModeTriggered || pendingOrders.length >= 3) {
          createNotification({
            type: 'NEW_ORDER',
            title: `🚨 Auto-Pilot Away Mode: ${pendingOrders.length} Orders Moved to Processing`,
            message: `Auto-Pilot detected ${pendingCount} pending orders while staff was away. Advanced ${pendingOrders.length} orders to Processing status so staff can inspect & pack them immediately.`,
            recipientRole: 'staff',
            total: pendingOrders.reduce((sum, o) => sum + o.total, 0),
          })
        }
      }
    }

    // 2. Realistic Fulfillment Progression (if autoDispatchOrders is active)
    if (autoPilot.autoDispatchOrders) {
      // Find all active in-progress orders
      const activeOrders = await Order.find({
        status: { $in: ['processing', 'packed', 'dispatched', 'shipped', 'out_for_delivery'] },
      }).limit(50)

      for (const order of activeOrders) {
        const orderAgeHours = (now.getTime() - new Date(order.createdAt).getTime()) / (1000 * 60 * 60)

        // Stage 2: processing -> packed (After ~4-5 hours)
        if (order.status === 'processing' && orderAgeHours >= limits.packedAfterHours) {
          order.status = 'packed'
          order.notes = (order.notes ? `${order.notes}\n` : '') + `[Auto-Pilot]: OEM quality inspection passed. Boxed & labeled for courier pickup.`
          await order.save()

          logs.push({
            action: 'Order Quality-Checked & Packed',
            details: `Order #${order._id.toString().slice(-6).toUpperCase()} packed at warehouse. Ready for evening courier handover.`,
            timestamp: now,
          })
          emitToStaff('order_updated', order.toObject())
          continue
        }

        // Stage 3: packed -> dispatched (Night/Evening handover, after ~10-12 hours)
        if (order.status === 'packed' && orderAgeHours >= limits.dispatchAfterHours) {
          order.status = 'dispatched'
          const trackingNum = `TCS-EXP-${order._id.toString().slice(-6).toUpperCase()}`
          order.notes = (order.notes ? `${order.notes}\n` : '') + `[Auto-Pilot]: Handed over to Express Courier (TCS / Leopards). Tracking ID: ${trackingNum}`
          await order.save()

          logs.push({
            action: 'Dispatched to Courier',
            details: `Order #${order._id.toString().slice(-6).toUpperCase()} dispatched via Express Courier (${trackingNum}).`,
            timestamp: now,
          })
          emitToStaff('order_updated', order.toObject())
          continue
        }

        // Stage 4: dispatched -> shipped (Next day evening, arrived at Express Hub, after ~24 hours)
        if (order.status === 'dispatched' && orderAgeHours >= limits.transitAfterHours) {
          order.status = 'shipped'
          order.notes = (order.notes ? `${order.notes}\n` : '') + `[Auto-Pilot]: Package scanned & arrived at Regional TCS Logistics Hub.`
          await order.save()

          logs.push({
            action: 'Arrived at Courier Hub',
            details: `Order #${order._id.toString().slice(-6).toUpperCase()} arrived at regional express distribution hub.`,
            timestamp: now,
          })
          emitToStaff('order_updated', order.toObject())
          continue
        }

        // Stage 5: shipped -> out_for_delivery (Day 2-3, after ~48 hours)
        if (order.status === 'shipped' && orderAgeHours >= limits.outForDeliveryHours) {
          order.status = 'out_for_delivery'
          order.notes = (order.notes ? `${order.notes}\n` : '') + `[Auto-Pilot]: Courier delivery rider assigned for final doorstep delivery.`
          await order.save()

          logs.push({
            action: 'Out for Doorstep Delivery',
            details: `Order #${order._id.toString().slice(-6).toUpperCase()} is out for delivery with local courier rider.`,
            timestamp: now,
          })
          emitToStaff('order_updated', order.toObject())
          continue
        }

        // Stage 6: out_for_delivery -> delivered (Day 3-4, after ~72 hours)
        if (order.status === 'out_for_delivery' && orderAgeHours >= limits.deliveredAfterHours) {
          order.status = 'delivered'
          order.notes = (order.notes ? `${order.notes}\n` : '') + `[Auto-Pilot]: Parcel safely delivered to recipient. Signed & completed.`
          await order.save()

          logs.push({
            action: 'Parcel Delivered Successfully',
            details: `Order #${order._id.toString().slice(-6).toUpperCase()} marked as delivered & completed.`,
            timestamp: now,
          })
          emitToStaff('order_updated', order.toObject())
          continue
        }
      }
    }

    // 3. Proactive Inventory Health Check & Restock Trigger
    const threshold = autoPilot.autoRestockAlertThreshold || 5
    const lowStockParts = await Part.find({ stock: { $gt: 0, $lte: threshold }, active: true }).lean()

    if (lowStockParts.length > 0 && Math.random() < 0.1) {
      const topLow = lowStockParts.slice(0, 3).map((p) => `${p.name} (${p.stock} left)`).join(', ')
      logs.push({
        action: 'Inventory Restock Alert',
        details: `${lowStockParts.length} items below safety threshold (${topLow}).`,
        timestamp: now,
      })
    }

    // 4. Update Settings doc with execution logs
    if (logs.length > 0) {
      settings.autoPilot.lastRunAt = now
      if (!settings.autoPilot.logs) settings.autoPilot.logs = []
      settings.autoPilot.logs.unshift(...logs)
      if (settings.autoPilot.logs.length > 50) {
        settings.autoPilot.logs = settings.autoPilot.logs.slice(0, 50)
      }
      await settings.save()

      try {
        emitToStaff('autopilot_cycle_completed', {
          actionsCount: logs.length,
          logs,
          timestamp: now,
        })
      } catch (e) {
        console.warn('Socket notification error:', e.message)
      }
    }

    return {
      active: true,
      actionsExecuted: logs.length,
      logs,
      lastRunAt: now,
    }
  } catch (err) {
    console.error('AutoPilot cycle error:', err)
    return { active: false, error: err.message }
  }
}

/**
 * Initialize Autonomous AutoPilot Background Worker
 * Interval: Runs every 30 seconds to advance orders according to real-world timelines
 */
export function startAutoPilotScheduler(intervalMs = 30 * 1000) {
  console.log('✓ Auto-Pilot Autonomous Store Operations worker running (Interval: 30s)')

  // Initial check on boot
  setTimeout(() => {
    runAutoPilotCycle().catch((e) => console.warn('AutoPilot startup cycle error:', e.message))
  }, 5000)

  // Recurring sweep
  setInterval(() => {
    runAutoPilotCycle().catch((e) => console.warn('AutoPilot sweep cycle error:', e.message))
  }, intervalMs)
}
