import Order from '../models/Order.js'
import Part from '../models/Part.js'
import Settings, { getSettingsDoc } from '../models/Settings.js'

const CANDIDATE_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-latest',
  'gemini-3.1-flash-lite',
]

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

// In-memory quota cooldown tracker to prevent 20s lag when Google API key runs out of quota
let quotaCooldownUntil = 0

/**
 * System Instructions for AutoGenuine AI Customer Support Assistant
 */
const SYSTEM_INSTRUCTION = `You are AutoGenuine's AI Customer Support Specialist — an expert, polite, and professional automotive concierge.
AutoGenuine is Pakistan's premier marketplace for 100% Genuine OEM Automotive Parts (Toyota, Honda, Suzuki, Nissan, Hyundai, KIA, Mitsubishi, etc.).

CRITICAL OPERATIONAL & FORMATTING RULES:
1. GREETING & TONE:
   - Maintain a friendly, polished, highly professional tone like a luxury concierge.
   - You understand English, Urdu, and Roman Urdu (e.g. "kia haal hn", "order kahan hai", "yeh part fit aye ga"). Respond politely in the language or Roman Urdu the customer prefers.
   - Be concise, direct, and helpful. Avoid fluff.
2. RICH FORMATTING:
   - Format lists with clean bullet points (* ).
   - Use bold (**text**) for important terms, order numbers, vehicle models, part names, and prices.
   - Separate distinct ideas with clean line breaks.
3. PURCHASING & CART GUIDANCE:
   - When a customer wants to buy, order, or add a part to cart (e.g. "add 5 parts to cart", "I want to buy this"), execute check_product_availability, confirm stock and total price, and advise them that they can add it to cart directly using the interactive card with your message!
4. CURRENCY & PRICING:
   - Currency is Pakistani Rupee (PKR / Rs). Always format prices clearly (e.g. "**Rs 18,500**").
5. NEVER HALLUCINATE OR GUESS:
   - Never invent order statuses, tracking info, delivery dates, or prices.
   - You MUST execute your tools (get_order_status, get_order_details, get_payment_status, get_product_details, check_product_availability) whenever an order, payment, or part is mentioned.
   - If a customer asks "Where is my order?" and you don't know the order reference, ask them politely for their Order Number / Reference (e.g. #ORD-XXXXXX).
6. VERIFIED STORE POLICIES:
   - Nationwide Express Dispatch: 2 to 4 business days across Pakistan via courier partners (TCS, Leopards, Trax).
   - 7-Day Return Policy: Returns accepted within 7 days of delivery for unused, unopened parts in original OEM packaging with invoice.
   - Genuine Guarantee: 100% Genuine OEM manufacturer warranty against factory defects.
   - Payment Methods: 3D-Secure Credit/Debit Cards via Stripe, Cash on Delivery (COD), Direct Bank Transfer, JazzCash, EasyPaisa.
7. ESCALATION RULES (MUST USE escalate_to_human tool):
   - Payment Discrepancies (money debited but order pending/failed) -> Target: "admin", Priority: "urgent" / "high".
   - Refund Requests / Chargebacks -> Target: "admin", Priority: "high".
   - Account / Security / Technical Issues -> Target: "admin", Priority: "high".
   - Damaged, Cracked, Defective, or Incorrect Part received -> Target: "owner", Priority: "high".
   - Customer explicitly asks to speak with a human agent or manager -> Target: "owner" or "admin", Priority: "high".
`

/**
 * Controlled Tools Definition for Gemini Function Calling
 */
const TOOL_DECLARATIONS = [
  {
    name: 'get_order_status',
    description: 'Lookup the current order processing status, payment status, and tracking summary for an AutoGenuine order using order reference (e.g., "ORD-1024", "#ORD-89440D").',
    parameters: {
      type: 'OBJECT',
      properties: {
        orderRef: {
          type: 'STRING',
          description: 'The order reference code (e.g., ORD-89440D or MongoDB ID).',
        },
      },
      required: ['orderRef'],
    },
  },
  {
    name: 'get_order_details',
    description: 'Fetch detailed line items, quantities, prices in PKR, and shipping details for a specific order reference.',
    parameters: {
      type: 'OBJECT',
      properties: {
        orderRef: {
          type: 'STRING',
          description: 'The order reference code (e.g., ORD-89440D).',
        },
      },
      required: ['orderRef'],
    },
  },
  {
    name: 'get_payment_status',
    description: 'Check payment verification status, gateway transaction reference, and paid timestamp for an order.',
    parameters: {
      type: 'OBJECT',
      properties: {
        orderRef: {
          type: 'STRING',
          description: 'The order reference code.',
        },
      },
      required: ['orderRef'],
    },
  },
  {
    name: 'get_delivery_status',
    description: 'Check dispatch status, courier handover, and estimated delivery timeline for an order.',
    parameters: {
      type: 'OBJECT',
      properties: {
        orderRef: {
          type: 'STRING',
          description: 'The order reference code.',
        },
      },
      required: ['orderRef'],
    },
  },
  {
    name: 'get_product_details',
    description: 'Search AutoGenuine catalog for genuine OEM parts by part slug, name, or vehicle model keywords to get price, stock, and fitment.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Part name, keyword, or part slug (e.g., "brake pad camry", "spark plug", "oil filter").',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'check_product_availability',
    description: 'Check stock level and availability for a specific part by its slug or name.',
    parameters: {
      type: 'OBJECT',
      properties: {
        productSlug: {
          type: 'STRING',
          description: 'The unique slug or identifier of the part.',
        },
        quantity: {
          type: 'INTEGER',
          description: 'Requested quantity (defaults to 1).',
        },
      },
      required: ['productSlug'],
    },
  },
  {
    name: 'get_customer_order_history',
    description: 'Fetch recent orders for the currently authenticated customer to help resolve their query.',
    parameters: {
      type: 'OBJECT',
      properties: {
        limit: {
          type: 'INTEGER',
          description: 'Number of recent orders to retrieve (max 5).',
        },
      },
    },
  },
  {
    name: 'get_support_policy',
    description: 'Retrieve verified AutoGenuine store policy information on shipping, returns, warranty, and payment methods.',
    parameters: {
      type: 'OBJECT',
      properties: {
        topic: {
          type: 'STRING',
          description: 'Policy topic: "shipping", "returns", "refunds", "warranty", "payment_methods", "contact".',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Escalate the current customer conversation to a human staff member (Admin or Store Owner) with full diagnostic summary.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: {
          type: 'STRING',
          description: 'Detailed reason for escalation.',
        },
        target: {
          type: 'STRING',
          enum: ['admin', 'owner'],
          description: 'Target recipient: "admin" for payments/accounts/refunds/system issues, "owner" for damaged/defective parts/disputes.',
        },
        category: {
          type: 'STRING',
          enum: [
            'payment_support',
            'order_support',
            'product_support',
            'delivery_support',
            'account_support',
            'general_support',
          ],
          description: 'The support category.',
        },
        priority: {
          type: 'STRING',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'Escalation priority level.',
        },
        customerSummary: {
          type: 'STRING',
          description: 'Concise 1-2 sentence summary of what the customer is experiencing.',
        },
        recommendedAction: {
          type: 'STRING',
          description: 'Recommended next action for the human staff member.',
        },
      },
      required: ['reason', 'target', 'category', 'priority', 'customerSummary', 'recommendedAction'],
    },
  },
]

/**
 * Executes a backend tool safely against MongoDB
 */
export async function executeBackendTool(toolName, args = {}, context = {}) {
  const { user, conversation } = context
  const userId = user?._id

  try {
    switch (toolName) {
      case 'get_order_status': {
        const queryRef = (args.orderRef || conversation?.orderRef || '').trim()
        if (!queryRef) {
          return { error: 'No order reference provided. Please provide an Order Reference (e.g., ORD-XXXXXX).' }
        }

        const normalizedRef = queryRef.replace(/^#/, '').toUpperCase()
        let order = null

        if (queryRef.match(/^[0-9a-fA-F]{24}$/)) {
          order = await Order.findById(queryRef).lean()
        }
        if (!order) {
          const userOrders = await Order.find(userId && user.role === 'user' ? { user: userId } : {}).lean()
          order = userOrders.find((o) => {
            const ref = `ORD-${String(o._id).slice(-6).toUpperCase()}`
            return (
              ref === normalizedRef ||
              String(o._id).toUpperCase().endsWith(normalizedRef) ||
              (o.transactionReference && o.transactionReference.toUpperCase().includes(normalizedRef))
            )
          })
        }

        if (!order) {
          return { found: false, message: `No order found matching "${queryRef}". Please verify the order number.` }
        }

        if (user && user.role === 'user' && String(order.user) !== String(userId)) {
          return { error: 'Access denied: This order belongs to another customer account.' }
        }

        return {
          found: true,
          orderRef: `ORD-${String(order._id).slice(-6).toUpperCase()}`,
          status: order.status,
          statusLabel: order.status.replace(/_/g, ' ').toUpperCase(),
          paymentStatus: order.paymentStatus,
          paymentMethod: order.paymentMethod,
          itemCount: order.items?.length || 0,
          totalFormatted: `Rs ${order.total.toLocaleString()}`,
          date: new Date(order.createdAt).toLocaleDateString(),
          city: order.city || 'Pakistan',
          hasTracking: Boolean(order.trackingNumber),
          trackingNumber: order.trackingNumber || 'Processing dispatch',
        }
      }

      case 'get_order_details': {
        const queryRef = (args.orderRef || conversation?.orderRef || '').trim()
        if (!queryRef) return { error: 'Order reference is required.' }

        const normalizedRef = queryRef.replace(/^#/, '').toUpperCase()
        const userOrders = await Order.find(userId && user.role === 'user' ? { user: userId } : {}).lean()
        const order = userOrders.find((o) => {
          const ref = `ORD-${String(o._id).slice(-6).toUpperCase()}`
          return ref === normalizedRef || String(o._id).toUpperCase().endsWith(normalizedRef)
        })

        if (!order) return { found: false, message: 'Order not found.' }

        return {
          found: true,
          orderRef: `ORD-${String(order._id).slice(-6).toUpperCase()}`,
          total: `Rs ${order.total.toLocaleString()}`,
          items: (order.items || []).map((it) => ({
            name: it.name,
            partSlug: it.partSlug,
            quantity: it.qty,
            unitPrice: `Rs ${it.price.toLocaleString()}`,
            lineTotal: `Rs ${(it.price * it.qty).toLocaleString()}`,
          })),
          shippingAddress: `${order.shippingAddress || ''}, ${order.city || ''}`,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
        }
      }

      case 'get_payment_status': {
        const queryRef = (args.orderRef || conversation?.orderRef || '').trim()
        if (!queryRef) return { error: 'Order reference is required.' }

        const normalizedRef = queryRef.replace(/^#/, '').toUpperCase()
        const userOrders = await Order.find(userId && user.role === 'user' ? { user: userId } : {}).lean()
        const order = userOrders.find((o) => {
          const ref = `ORD-${String(o._id).slice(-6).toUpperCase()}`
          return ref === normalizedRef || String(o._id).toUpperCase().endsWith(normalizedRef)
        })

        if (!order) return { found: false, message: 'Order not found.' }

        return {
          orderRef: `ORD-${String(order._id).slice(-6).toUpperCase()}`,
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
          total: `Rs ${order.total.toLocaleString()}`,
          paidAt: order.paidAt,
          transactionRef: order.transactionReference || 'N/A',
          isFullyPaid: order.paymentStatus === 'paid',
        }
      }

      case 'get_delivery_status': {
        const queryRef = (args.orderRef || conversation?.orderRef || '').trim()
        if (!queryRef) return { error: 'Order reference is required.' }

        const normalizedRef = queryRef.replace(/^#/, '').toUpperCase()
        const userOrders = await Order.find(userId && user.role === 'user' ? { user: userId } : {}).lean()
        const order = userOrders.find((o) => {
          const ref = `ORD-${String(o._id).slice(-6).toUpperCase()}`
          return ref === normalizedRef || String(o._id).toUpperCase().endsWith(normalizedRef)
        })

        if (!order) return { found: false, message: 'Order not found.' }

        const statusMap = {
          pending: 'Your order has been received and is awaiting processing approval.',
          processing: 'Order approved! Parts are currently being packed in our warehouse.',
          packed: 'Order packed in secure protective packaging, ready for courier handover.',
          dispatched: 'Dispatched from central warehouse with our courier partner.',
          out_for_delivery: 'Out for delivery today with courier delivery agent.',
          shipped: 'In transit to your delivery destination.',
          delivered: 'Package successfully delivered.',
          cancelled: 'This order was cancelled.',
        }

        return {
          orderRef: `ORD-${String(order._id).slice(-6).toUpperCase()}`,
          status: order.status,
          statusDescription: statusMap[order.status] || 'Processing',
          city: order.city,
          estimatedDays: '2 to 4 business days nationwide',
        }
      }

      case 'get_product_details': {
        const query = (args.query || conversation?.productSlug || '').trim()
        if (!query) return { error: 'Search query or part code is required.' }

        const terms = query.split(/\s+/).filter((t) => t.length > 1)

        const parts = await Part.find({
          $or: [
            { slug: { $regex: query, $options: 'i' } },
            { name: { $regex: query, $options: 'i' } },
            { fits: { $regex: query, $options: 'i' } },
            { sku: { $regex: query, $options: 'i' } },
            ...(terms.length > 1
              ? [
                  {
                    $and: terms.map((t) => ({
                      $or: [
                        { name: { $regex: t, $options: 'i' } },
                        { fits: { $regex: t, $options: 'i' } },
                        { slug: { $regex: t, $options: 'i' } },
                        { categorySlug: { $regex: t, $options: 'i' } },
                      ],
                    })),
                  },
                ]
              : []),
          ],
          active: true,
        })
          .limit(4)
          .lean()

        if (!parts || parts.length === 0) {
          return { found: false, message: `No genuine parts found matching "${query}".` }
        }

        return {
          found: true,
          count: parts.length,
          product: {
            id: parts[0].slug,
            slug: parts[0].slug,
            name: parts[0].name,
            price: parts[0].price,
            stock: parts[0].stock,
            image: parts[0].image,
            fits: parts[0].fits,
            qty: 1,
          },
          parts: parts.map((p) => ({
            id: p.slug,
            name: p.name,
            slug: p.slug,
            price: p.price,
            priceFormatted: `Rs ${p.price.toLocaleString()}`,
            stock: p.stock > 0 ? `${p.stock} available in stock` : 'Out of stock',
            availableStock: p.stock,
            fits: p.fits,
            badge: p.badge || 'Genuine OEM',
            image: p.image,
          })),
        }
      }

      case 'check_product_availability': {
        const slug = (args.productSlug || conversation?.productSlug || '').trim()
        const qty = Number(args.quantity) || 1

        const part = await Part.findOne({
          $or: [{ slug }, { name: { $regex: slug, $options: 'i' } }],
          active: true,
        }).lean()

        if (!part) return { found: false, message: `Part "${slug}" not found.` }

        const available = part.stock >= qty
        return {
          found: true,
          partName: part.name,
          partSlug: part.slug,
          price: part.price,
          inStock: available,
          availableStock: part.stock,
          requestedQty: qty,
          priceFormatted: `Rs ${part.price.toLocaleString()}`,
          message: available
            ? `In Stock: ${part.stock} units available (Price: Rs ${part.price.toLocaleString()} each).`
            : `Insufficient stock: Only ${part.stock} units available.`,
          product: {
            id: part.slug,
            slug: part.slug,
            name: part.name,
            price: part.price,
            stock: part.stock,
            image: part.image,
            fits: part.fits,
            qty,
          },
        }
      }

      case 'get_customer_order_history': {
        if (!userId) return { error: 'Customer is not logged in.' }

        const limit = Math.min(Number(args.limit) || 5, 10)
        const orders = await Order.find({ user: userId })
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean()

        return {
          count: orders.length,
          orders: orders.map((o) => ({
            orderRef: `ORD-${String(o._id).slice(-6).toUpperCase()}`,
            status: o.status,
            totalFormatted: `Rs ${o.total.toLocaleString()}`,
            itemsCount: o.items?.length || 0,
            date: new Date(o.createdAt).toLocaleDateString(),
            paymentStatus: o.paymentStatus,
          })),
        }
      }

      case 'get_support_policy': {
        const topic = (args.topic || '').toLowerCase()
        const settings = await getSettingsDoc()

        const policies = {
          shipping: `**Nationwide Delivery Across Pakistan:**\n* **Express Timeline:** 2 to 4 business days via verified courier partners (TCS, Leopards, Trax).\n* **Shipping Fee:** Rs ${settings.shippingFee || 0}${settings.freeShippingOver ? ` (Free express shipping on orders over **Rs ${settings.freeShippingOver.toLocaleString()}**)` : ''}.\n* **Live Tracking:** Real-time tracking link provided upon warehouse dispatch.`,
          returns: `**AutoGenuine 7-Day Return & Replacement Policy:**\n* **7-Day Window:** Returns accepted within 7 days of package delivery.\n* **Condition:** Parts must be unused, uninstalled, and in original OEM factory packaging with seal and invoice intact.\n* **Fast Inspection:** Return pickup and inspection completed within 48 hours.`,
          refunds: `**Refund Processing:**\n* **Method:** Refunds are processed back to your original payment method (Credit/Debit card or Bank Account).\n* **Timeline:** Completed within 3 to 5 business days upon warehouse verification.`,
          warranty: `**100% Genuine OEM Authenticity Guarantee:**\n* **Manufacturer Warranty:** Full factory warranty against defects on all original parts.\n* **Fitment Guarantee:** Exact vehicle fitment guaranteed when matching your chassis/VIN or vehicle year.`,
          payment_methods: `**Accepted Payment Methods:**\n* **Credit / Debit Cards:** 3D-Secure card processing via Stripe (Visa, Mastercard, UnionPay).\n* **Cash on Delivery (COD):** Available for nationwide orders across Pakistan.\n* **Direct Bank Transfer:** Instant verified IBAN transfer to official AutoGenuine account.\n* **Mobile Wallets:** Fast checkout via JazzCash and EasyPaisa.`,
          contact: `**AutoGenuine Customer Support:**\n* **Email:** ${settings.supportEmail || 'support@autogenuine.com'}\n* **WhatsApp:** ${settings.whatsappNumber || '+92 321 3498203'}\n* **Location:** ${settings.address || 'Lahore, Pakistan'}`,
        }

        return {
          topic,
          policy: policies[topic] || policies.returns || policies.shipping,
        }
      }

      case 'escalate_to_human': {
        return {
          isEscalationTrigger: true,
          reason: args.reason,
          target: args.target || 'admin',
          category: args.category || 'general_support',
          priority: args.priority || 'medium',
          customerSummary: args.customerSummary,
          recommendedAction: args.recommendedAction,
        }
      }

      default:
        return { error: `Tool ${toolName} not implemented.` }
    }
  } catch (err) {
    return { error: `Tool execution failed: ${err.message}` }
  }
}

/**
 * Intelligent Local Standby Support Engine
 * Guarantees zero latency and friendly conversational responses in English, Urdu, and Roman Urdu.
 */
async function processLocalHybridSupport({ conversation, user, customerMessageText, cleanInput }) {
  // 0. Payment & Financial Disputes (Auto-Escalate to Admin)
  if (
    cleanInput.includes('charged') ||
    cleanInput.includes('deducted') ||
    cleanInput.includes('charge') ||
    cleanInput.includes('dispute') ||
    cleanInput.includes('refund') ||
    (cleanInput.includes('card') && cleanInput.includes('pending'))
  ) {
    return {
      aiText: `I understand your concern regarding this payment charge. I have escalated this transaction to our **Admin Support Team** with high priority so they can verify the payment gateway records and assist you immediately.`,
      shouldEscalate: true,
      escalation: {
        reason: 'Payment charge dispute / pending order verification',
        target: 'admin',
        category: 'payment_support',
        priority: 'high',
        customerSummary: customerMessageText || 'Customer reported payment deducted but order is pending.',
        recommendedAction: 'Verify Stripe gateway transaction and update order payment status.',
      },
      toolsUsed: ['escalate_to_human'],
    }
  }

  // 1. Language Preferences & Roman Urdu inquiries ("can we talk in roman urdu", "urdu aati hai", "urdu me baat kro")
  if (
    cleanInput.includes('roman urdu') ||
    cleanInput.includes('urdu') ||
    cleanInput.includes('urdu mein') ||
    cleanInput.includes('urdu me') ||
    cleanInput.includes('talk in urdu') ||
    cleanInput.includes('speak urdu')
  ) {
    return {
      aiText: `Jee bilkul bhai! Hum **Roman Urdu** mein baat kar sakte hain. AutoGenuine Customer Support par aapka khushamdeed!\n\nAapko kis cheez mein madad chahiye?\n* **Order Tracking:** Apne order (#ORD-XXXXX) ka live status check karein.\n* **100% Genuine OEM Parts:** Toyota, Honda, Suzuki waghera ke original spare parts aur fitment maloom karein.\n* **Store Policies:** Hamari 7-din return policy aur payment methods (Stripe / Cash on Delivery) ke baaray mein poochein.\n\nAap apna sawal Roman Urdu mein likhein, main aapko poori detail ke sath jawab dunga!`,
      shouldEscalate: false,
      toolsUsed: [],
    }
  }

  // 2. Casual Greetings & Roman Urdu ("kia haal hn", "kese ho", "salam", "hi", "hello")
  if (
    cleanInput.includes('kia haal') ||
    cleanInput.includes('kya haal') ||
    cleanInput.includes('kese ho') ||
    cleanInput.includes('kaise ho') ||
    cleanInput.includes('theek ho') ||
    cleanInput.includes('salam') ||
    cleanInput.includes('aoa') ||
    cleanInput.includes('assalam') ||
    cleanInput.includes('bhai') ||
    cleanInput === 'hi' ||
    cleanInput === 'hello' ||
    cleanInput === 'hey'
  ) {
    const isUrdu = cleanInput.includes('kia haal') || cleanInput.includes('kya haal') || cleanInput.includes('kese ho') || cleanInput.includes('salam') || cleanInput.includes('bhai')
    if (isUrdu) {
      return {
        aiText: `Walaikum Assalam! Shukriya bhai, Allah ka shukar bilkul theek! AutoGenuine Customer Support mein khushamdeed.\n\nMain aapki kya madad kar sakta hoon? Aap kisi order (#ORD-XXXXX) ka status check karna chahte hain ya kisi OEM Genuine part (Toyota, Honda, Suzuki) ki availability dekhni hai?`,
        shouldEscalate: false,
        toolsUsed: [],
      }
    }
    return {
      aiText: `Hello ${user?.name || 'there'}! AutoGenuine Customer Support is here to help. How can I assist you with your orders, genuine OEM parts, or store policies today?`,
      shouldEscalate: false,
      toolsUsed: [],
    }
  }

  // 2. Policy Inquiries (Returns, Warranty, Shipping, Payment)
  if (
    cleanInput.includes('return') ||
    cleanInput.includes('warranty') ||
    cleanInput.includes('shipping') ||
    cleanInput.includes('delivery') ||
    cleanInput.includes('payment') ||
    cleanInput.includes('pay')
  ) {
    const topic = cleanInput.includes('return')
      ? 'returns'
      : cleanInput.includes('warranty')
      ? 'warranty'
      : cleanInput.includes('payment') || cleanInput.includes('pay')
      ? 'payment_methods'
      : 'shipping'
    const policyData = await executeBackendTool('get_support_policy', { topic }, { user, conversation })
    if (policyData?.policy) {
      return {
        aiText: `${policyData.policy}\n\nPlease let me know if you need help checking a specific order or finding genuine parts!`,
        shouldEscalate: false,
        toolsUsed: ['get_support_policy'],
      }
    }
  }

  // 2.5 Price Inquiry, Discounts, Proposing Lower Price / Negotiation
  if (
    cleanInput.includes('propose') ||
    cleanInput.includes('lower') ||
    cleanInput.includes('lowering') ||
    cleanInput.includes('discount') ||
    cleanInput.includes('price') ||
    cleanInput.includes('cost') ||
    cleanInput.includes('offer') ||
    cleanInput.includes('rate') ||
    cleanInput.includes('timing belt') ||
    cleanInput.includes('belt') ||
    cleanInput.includes('how much')
  ) {
    const isUrdu = cleanInput.includes('kitne') || cleanInput.includes('dam') || cleanInput.includes('kam') || cleanInput.includes('bhai')
    return {
      aiText: isUrdu
        ? `Aapke price proposal / discount ki request receive ho gayi hai!\n\nHamare tamam OEM genuine parts direct distributor wholesale rates par listed hain. Agar aap bulk order ya special price offer propose karna chahte hain, toh main aapki yeh request hamari **Store Owner & Admin Team** ko forward kar sakta hoon.\n\nKya aap chahte hain main yeh chat Admin support agent ko transfer kar doon?`
        : `Thank you for your price inquiry and proposal!\n\nOur listed store prices for 100% Genuine OEM Parts reflect official wholesale distributor pricing. For custom price proposals, bulk quotes, or special discounts, I can forward your request directly to our **Store Owner & Admin Team**.\n\nWould you like me to connect you with an admin support agent right now to review your price proposal?`,
      shouldEscalate: false,
      toolsUsed: [],
    }
  }

  // 3. Part Search or Add to Cart Request
  if (
    cleanInput.includes('part') ||
    cleanInput.includes('oil filter') ||
    cleanInput.includes('brake') ||
    cleanInput.includes('plug') ||
    cleanInput.includes('cart') ||
    cleanInput.includes('buy') ||
    conversation?.productSlug
  ) {
    const query = conversation?.productSlug || 'oil filter'
    const qtyMatch = cleanInput.match(/\b(\d+)\b/)
    const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1
    const checkRes = await executeBackendTool('check_product_availability', { productSlug: query, quantity: qty }, { user, conversation })

    if (checkRes?.found) {
      return {
        aiText: `I found **${checkRes.partName}** in our catalog! You can review details and add **${qty} unit${qty > 1 ? 's' : ''}** directly to your cart using the interactive card below:`,
        shouldEscalate: false,
        toolsUsed: ['check_product_availability'],
        productData: checkRes.product,
      }
    }
  }

  // 4. Order Status Inquiry (Trigger ONLY when user asks about order status or tracking)
  const isOrderQuery =
    cleanInput.includes('track') ||
    cleanInput.includes('status') ||
    cleanInput.includes('where is') ||
    cleanInput.includes('shipment') ||
    cleanInput.includes('delivery status') ||
    cleanInput.includes('ord-') ||
    (cleanInput.includes('order') && !cleanInput.includes('propose') && !cleanInput.includes('lower') && !cleanInput.includes('price'))

  if (isOrderQuery && (conversation?.orderRef || cleanInput.includes('ord-') || cleanInput.includes('order'))) {
    const orderData = await executeBackendTool('get_order_status', { orderRef: conversation?.orderRef }, { user, conversation })
    if (orderData?.found) {
      return {
        aiText: `**Order #${orderData.orderRef} Status:**\n* **Current Status:** **${orderData.statusLabel}**\n* **Payment:** ${orderData.paymentStatus.toUpperCase()} via ${orderData.paymentMethod.toUpperCase()}\n* **Items:** ${orderData.itemCount} items (${orderData.totalFormatted})\n* **Tracking:** ${orderData.trackingNumber}\n\nPlease let me know if you need any further details regarding this shipment!`,
        shouldEscalate: false,
        toolsUsed: ['get_order_status'],
        orderData,
      }
    }
  }

  // 5. Explicit Human Transfer
  if (
    cleanInput.includes('human') ||
    cleanInput.includes('agent') ||
    cleanInput.includes('owner') ||
    cleanInput.includes('admin') ||
    cleanInput.includes('representative')
  ) {
    return {
      aiText: `I've connected this conversation with our Support Team. An agent (Admin / Store Owner) has received your request and will assist you shortly.`,
      shouldEscalate: true,
      escalation: {
        reason: 'Customer requested human support representative',
        target: 'admin',
        category: conversation?.supportCategory || 'general_support',
        priority: 'high',
        customerSummary: customerMessageText || 'Customer requested human agent.',
        recommendedAction: 'Greet customer and assist with inquiry.',
      },
      toolsUsed: ['escalate_to_human'],
    }
  }

  // Default Polite Standby Response
  return {
    aiText: `Hello! AutoGenuine Support is ready to assist you:\n* **Order Tracking:** Inquire about any #ORD reference.\n* **100% Genuine OEM Parts:** Check price, fitment, and stock.\n* **Store Policies:** 7-Day returns, warranty, and payment options.\n\nHow can I help you today?`,
    shouldEscalate: false,
    toolsUsed: [],
  }
}

/**
 * Dispatches an API call with automatic multi-model failover.
 */
async function callGeminiWithFailover(payload, apiKey) {
  const modelsToTry = [
    process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    ...CANDIDATE_MODELS,
  ].filter((v, i, a) => a.indexOf(v) === i)

  let lastError = null

  for (const model of modelsToTry) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 8000)

      const response = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        return await response.json()
      }

      if (response.status === 429) {
        console.warn(`⚠️ [geminiService] Model ${model} returned 429 quota limit. Retrying in 1s...`)
        quotaCooldownUntil = Date.now() + 1500
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }

      const errorBody = await response.text()
      console.warn(`⚠️ [geminiService] Model ${model} returned ${response.status}: ${errorBody.slice(0, 80)}`)
    } catch (e) {
      lastError = e
      if (e.message === 'QUOTA_EXCEEDED_429') {
        throw e
      }
    }
  }

  throw lastError || new Error('All Gemini candidate models unavailable')
}

/**
 * Main AI Support Orchestrator
 */
export async function processCustomerMessageWithAI({ conversation, user, customerMessageText }) {
  const apiKey = process.env.GEMINI_API_KEY
  const cleanInput = (customerMessageText || '').toLowerCase()

  // 1. If currently in quota cooldown or no API key, use fast local hybrid support immediately
  if (Date.now() < quotaCooldownUntil || !apiKey || apiKey.trim() === '' || apiKey === 'YOUR_GEMINI_API_KEY') {
    return await processLocalHybridSupport({ conversation, user, customerMessageText, cleanInput })
  }

  try {
    const { default: Message } = await import('../models/Message.js')
    const dbMessages = await Message.find({
      conversation: conversation._id,
      deleted: { $ne: true },
    })
      .sort({ createdAt: 1 })
      .limit(8)
      .lean()

    const contents = []

    for (const msg of dbMessages) {
      if (msg.type === 'system') continue
      const role = msg.isAI || msg.senderRole === 'ai' ? 'model' : 'user'
      if (msg.text) {
        contents.push({
          role,
          parts: [{ text: msg.text }],
        })
      }
    }

    if (!contents.length || contents[contents.length - 1].role !== 'user') {
      contents.push({
        role: 'user',
        parts: [{ text: customerMessageText || 'Hello' }],
      })
    }

    const contextNote = `[Context: Customer Name: "${user?.name || 'Customer'}", Email: "${user?.email || 'N/A'}"${conversation.orderRef ? `, Linked Order: "${conversation.orderRef}"` : ''}${conversation.productSlug ? `, Linked Part: "${conversation.productSlug}"` : ''}]`
    if (contents.length > 0 && contents[0].parts?.[0]?.text) {
      contents[0].parts[0].text = `${contextNote}\n${contents[0].parts[0].text}`
    }

    const toolsUsed = []
    let finalAiText = ''
    let escalationTrigger = null
    let extractedProduct = null
    let extractedOrder = null
    let currentContents = [...contents]

    for (let turn = 0; turn < 2; turn++) {
      const payload = {
        contents: currentContents,
        systemInstruction: {
          parts: [{ text: SYSTEM_INSTRUCTION }],
        },
        tools: [
          {
            functionDeclarations: TOOL_DECLARATIONS,
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 800,
        },
      }

      const data = await callGeminiWithFailover(payload, apiKey)
      const candidate = data.candidates?.[0]
      const parts = candidate?.content?.parts || []

      const functionCalls = parts.filter((p) => p.functionCall)

      if (functionCalls.length > 0) {
        const functionResponseParts = []

        for (const fc of functionCalls) {
          const { name, args } = fc.functionCall
          toolsUsed.push(name)

          const toolResult = await executeBackendTool(name, args, { user, conversation })

          if (toolResult.product) {
            extractedProduct = toolResult.product
          } else if (toolResult.parts?.[0]) {
            extractedProduct = toolResult.parts[0]
          }

          if (toolResult.orderRef) {
            extractedOrder = toolResult
          }

          if (toolResult.isEscalationTrigger) {
            escalationTrigger = toolResult
          }

          functionResponseParts.push({
            functionResponse: {
              name,
              response: { content: toolResult },
            },
          })
        }

        currentContents.push({
          role: 'model',
          parts,
        })
        currentContents.push({
          role: 'user',
          parts: functionResponseParts,
        })

        if (escalationTrigger) {
          continue
        }
      } else {
        const textParts = parts.filter((p) => p.text).map((p) => p.text)
        finalAiText = textParts.join('\n\n').trim()
        break
      }
    }

    if (!finalAiText && escalationTrigger) {
      finalAiText = `I have connected this conversation with our ${escalationTrigger.target === 'owner' ? 'Store Owner' : 'Admin Support'} team with high priority.\n\nReason: ${escalationTrigger.reason}\n\nOur team has received full context and will join this chat momentarily.`
    }

    return {
      aiText: finalAiText || 'I am checking into this for you right now.',
      shouldEscalate: Boolean(escalationTrigger),
      escalation: escalationTrigger,
      toolsUsed,
      productData: extractedProduct,
      orderData: extractedOrder,
    }
  } catch (err) {
    console.warn('⚠️ [geminiService] Cloud API fallback. Processing via Local Hybrid Engine:', err.message)
    return await processLocalHybridSupport({ conversation, user, customerMessageText, cleanInput })
  }
}
