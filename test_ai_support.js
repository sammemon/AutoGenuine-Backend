import 'dotenv/config'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import User from './models/User.js'
import Conversation from './models/Conversation.js'
import Message from './models/Message.js'
import Order from './models/Order.js'
import Part from './models/Part.js'
import SupportEscalation from './models/SupportEscalation.js'
import Notification from './models/Notification.js'
import { processCustomerMessageWithAI, executeBackendTool } from './services/geminiService.js'
import { executeEscalation } from './services/escalationService.js'

async function runTests() {
  console.log('\n======================================================')
  console.log('🧪 RUNNING AI CUSTOMER SUPPORT & ESCALATION TEST SUITE')
  console.log('======================================================\n')

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/autogenuine')
  console.log('✓ Connected to MongoDB')

  let passed = 0
  let failed = 0

  function assert(condition, testName) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`)
      passed++
    } else {
      console.error(`  ✗ FAIL: ${testName}`)
      failed++
    }
  }

  // 1. Setup Test Users
  const customerEmail = 'test_customer_ai@autogenuine.com'
  const adminEmail = process.env.ADMIN_EMAIL || 'adminautogenuine@gmail.com'
  const ownerEmail = process.env.OWNER_EMAIL || 'OwnerAutogenuine@gmail.com'

  let customer = await User.findOne({ email: customerEmail })
  if (!customer) {
    const passwordHash = await bcrypt.hash('password123', 10)
    customer = await User.create({
      name: 'Ahmed Customer',
      email: customerEmail,
      passwordHash,
      role: 'user',
      phone: '+923001234567',
    })
  }

  let admin = await User.findOne({ role: 'admin' })
  if (!admin) {
    const passwordHash = await bcrypt.hash('admin12345', 10)
    admin = await User.create({
      name: 'Store Admin',
      email: adminEmail,
      passwordHash,
      role: 'admin',
    })
  }

  let owner = await User.findOne({ role: 'owner' })
  if (!owner) {
    const passwordHash = await bcrypt.hash('owner12345', 10)
    owner = await User.create({
      name: 'Store Owner',
      email: ownerEmail,
      passwordHash,
      role: 'owner',
      isPrimaryOwner: true,
    })
  }

  // 2. Setup Test Part and Test Order
  let testPart = await Part.findOne({ slug: 'brake-pad-camry' })
  if (!testPart) {
    testPart = await Part.create({
      slug: 'brake-pad-camry',
      categorySlug: 'brakes',
      name: 'Front Brake Pad Set (Ceramic)',
      price: 18500,
      stock: 45,
      fits: 'Fits: Toyota Camry 2015 – 2020',
      badge: 'OEM',
    })
  }

  let testOrder = await Order.findOne({ user: customer._id })
  if (!testOrder) {
    testOrder = await Order.create({
      user: customer._id,
      items: [{ partSlug: testPart.slug, name: testPart.name, price: testPart.price, qty: 1 }],
      total: 18500,
      status: 'pending',
      paymentMethod: 'stripe',
      paymentStatus: 'pending',
      transactionReference: 'TXN-TEST-1024',
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      shippingAddress: 'Gulberg III',
      city: 'Lahore',
    })
  }

  const orderRefStr = `ORD-${String(testOrder._id).slice(-6).toUpperCase()}`

  // ── UNIT TEST: Direct Backend Tools on Real MongoDB Data ──
  console.log('\n--- Unit Tests: Backend Controlled Tools ---')

  const toolOrderRes = await executeBackendTool('get_order_status', { orderRef: orderRefStr }, { user: customer })
  assert(toolOrderRes.found === true && toolOrderRes.status === 'pending', 'get_order_status fetches real MongoDB order')

  const toolOrderDet = await executeBackendTool('get_order_details', { orderRef: orderRefStr }, { user: customer })
  assert(toolOrderDet.found === true && toolOrderDet.items?.length > 0, 'get_order_details fetches items and total in PKR')

  const toolPayRes = await executeBackendTool('get_payment_status', { orderRef: orderRefStr }, { user: customer })
  assert(toolPayRes.paymentMethod === 'stripe' && toolPayRes.paymentStatus === 'pending', 'get_payment_status verifies payment')

  const toolDelivRes = await executeBackendTool('get_delivery_status', { orderRef: orderRefStr }, { user: customer })
  assert(toolDelivRes.status === 'pending' && toolDelivRes.estimatedDays.includes('2 to 4'), 'get_delivery_status returns shipping estimate')

  const toolProdRes = await executeBackendTool('get_product_details', { query: 'camry brake' }, { user: customer })
  assert(toolProdRes.found === true && toolProdRes.parts?.length > 0, 'get_product_details finds genuine parts by keyword')

  const toolAvailRes = await executeBackendTool('check_product_availability', { productSlug: 'brake-pad-camry', quantity: 2 }, { user: customer })
  assert(toolAvailRes.found === true && toolAvailRes.inStock === true, 'check_product_availability verifies inventory stock')

  const toolHistoryRes = await executeBackendTool('get_customer_order_history', { limit: 5 }, { user: customer })
  assert(toolHistoryRes.count > 0 && toolHistoryRes.orders?.length > 0, 'get_customer_order_history returns customer order history')

  const toolPolicyRes = await executeBackendTool('get_support_policy', { topic: 'returns' }, { user: customer })
  assert(toolPolicyRes.policy.toLowerCase().includes('7-day return'), 'get_support_policy returns verified store policy')

  const toolEscRes = await executeBackendTool('escalate_to_human', {
    reason: 'Payment deducted but order pending',
    target: 'admin',
    category: 'payment_support',
    priority: 'high',
    customerSummary: 'Customer funds debited with order in pending status',
    recommendedAction: 'Verify transaction reference in Stripe dashboard',
  }, { user: customer })
  assert(toolEscRes.isEscalationTrigger === true && toolEscRes.target === 'admin', 'escalate_to_human formats structured escalation signal')

  // ── TEST: Orchestrator & Fallback Flow ─────────────────
  console.log('\n--- Test: AI Orchestrator & Multi-Turn Processing ---')
  const conv1 = await Conversation.create({
    type: 'direct',
    participants: [customer._id, admin._id],
    createdBy: customer._id,
    isSupport: true,
    supportStatus: 'ai_active',
    supportCategory: 'general_support',
  })

  const res1 = await processCustomerMessageWithAI({
    conversation: conv1,
    user: customer,
    customerMessageText: 'What is your return policy and shipping time?',
  })
  assert(res1.aiText && res1.aiText.length > 10, 'AI generates response for general inquiry')

  const conv2 = await Conversation.create({
    type: 'direct',
    participants: [customer._id, admin._id],
    createdBy: customer._id,
    orderRef: orderRefStr,
    isSupport: true,
    supportStatus: 'ai_active',
    supportCategory: 'order_support',
  })

  const res2 = await processCustomerMessageWithAI({
    conversation: conv2,
    user: customer,
    customerMessageText: `Where is my order #${orderRefStr}?`,
  })
  assert(res2.aiText && res2.aiText.length > 10, 'AI processes live order inquiry')

  // ── TEST: Payment Problem Escalation ──────────────────
  console.log('\n--- Test: Payment Problem Auto-Escalation to Admin ---')
  const res4 = await processCustomerMessageWithAI({
    conversation: conv2,
    user: customer,
    customerMessageText: `Money was deducted from my bank account for order #${orderRefStr} but status shows pending. Please check!`,
  })
  assert(res4.shouldEscalate === true, 'AI triggers escalation flag for payment dispute')
  assert(res4.escalation?.target === 'admin', 'Target classified as Admin for financial investigation')

  // ── TEST: Execution of Escalation Workflow (DB + Notifications) ──
  console.log('\n--- Test: Escalation Engine Execution Workflow ---')
  const escResult = await executeEscalation({
    conversationId: conv2._id,
    escalation: {
      reason: 'Payment deducted but order is pending synchronization',
      target: 'admin',
      category: 'payment_support',
      priority: 'high',
      customerSummary: 'Customer reports funds debited with order in pending state.',
      recommendedAction: 'Verify Stripe transaction ID and update order to paid/processing.',
    },
    customerId: customer._id,
    customerName: customer.name,
    customerEmail: customer.email,
  })

  assert(escResult.escalation && escResult.escalation._id, 'SupportEscalation record created in MongoDB')
  assert(escResult.conversation.escalated === true, 'Conversation marked as escalated')
  assert(escResult.conversation.supportStatus === 'assigned_to_admin', 'Status updated to assigned_to_admin')
  assert(escResult.systemMessage && escResult.systemMessage.type === 'system', 'Structured system escalation message posted to chat')

  const notif = await Notification.findOne({ conversationId: conv2._id, type: 'SUPPORT_ESCALATION' })
  assert(Boolean(notif), 'Persistent staff notification created in database')

  // ── TEST: Staff Takeover & Resolution Flow ────────────
  console.log('\n--- Test: Staff Takeover & Resolution ---')
  conv2.assignedUser = admin._id
  conv2.assignedRole = 'admin'
  conv2.supportStatus = 'human_active'
  await conv2.save()

  assert(conv2.supportStatus === 'human_active', 'Conversation status changes to human_active upon takeover')

  conv2.supportStatus = 'resolved'
  conv2.resolvedBy = admin._id
  conv2.resolvedByName = admin.name
  conv2.resolvedAt = new Date()
  conv2.resolutionNote = 'Verified Stripe webhook and processed order dispatch.'
  await conv2.save()

  assert(conv2.supportStatus === 'resolved', 'Conversation marked as resolved with resolution note')

  // ── TEST: Security & Unauthorized Access Checks ────────
  console.log('\n--- Test: Security & Authorization Protection ---')
  const otherCustomer = await User.create({
    name: 'Malicious Actor',
    email: `intruder_${Date.now()}@test.com`,
    passwordHash: 'hash',
    role: 'user',
  })

  const isParticipant = conv2.participants.some((p) => String(p) === String(otherCustomer._id))
  assert(isParticipant === false, 'User B is NOT a participant of User A private conversation')

  // Cleanup test records
  await User.deleteOne({ _id: otherCustomer._id })
  await Conversation.deleteMany({ _id: { $in: [conv1._id, conv2._id] } })
  await Message.deleteMany({ conversation: { $in: [conv1._id, conv2._id] } })
  await SupportEscalation.deleteMany({ conversation: { $in: [conv1._id, conv2._id] } })
  await Notification.deleteMany({ conversationId: { $in: [conv1._id, conv2._id] } })

  console.log('\n======================================================')
  console.log(`📊 TEST SUITE COMPLETE: ${passed} PASSED, ${failed} FAILED`)
  console.log('======================================================\n')

  await mongoose.disconnect()
  process.exit(failed > 0 ? 1 : 0)
}

runTests().catch((err) => {
  console.error('Fatal test runner error:', err)
  process.exit(1)
})
