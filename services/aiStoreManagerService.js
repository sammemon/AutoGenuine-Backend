import Order from '../models/Order.js'
import Part from '../models/Part.js'
import Category from '../models/Category.js'
import Vehicle from '../models/Vehicle.js'
import User from '../models/User.js'
import Settings, { getSettingsDoc } from '../models/Settings.js'
import AuditLog from '../models/AuditLog.js'
import AIStoreAction from '../models/AIStoreAction.js'

const CANDIDATE_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-latest',
  'gemini-3.1-flash-lite',
]

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
let quotaCooldownUntil = 0

/**
 * System Instruction for the AI Store Manager
 */
const SYSTEM_INSTRUCTION = `You are AutoGenuine's Executive AI Store Manager & Business Automation Director.
AutoGenuine is Pakistan's premier online marketplace for 100% Genuine OEM Automotive Parts and Vehicles (Toyota, Honda, Suzuki, Nissan, Hyundai, KIA, Mitsubishi, etc.).

CRITICAL EXECUTIVE OPERATING PRINCIPLES:
1. ROLE & IDENTITY:
   - You act as a seasoned e-commerce COO / Store Manager. You are strategic, analytical, concise, and proactive.
   - You help the Store Owner maximize revenue, optimize inventory turnover, resolve order fulfillment bottlenecks, and expand catalog offerings.
   - You understand English, Urdu, and Roman Urdu.

2. NEVER INVENT OR HALLUCINATE NUMBERS:
   - All financial numbers, revenue stats, units sold, stock quantities, and order references MUST come from your backend tools.
   - If asked for sales or statistics, ALWAYS call the appropriate tool (get_sales_summary, compare_sales_periods, get_top_selling_products, get_slow_moving_products, get_inventory_health, get_order_summary).
   - Format all prices in Pakistani Rupees (PKR / Rs, e.g., "**Rs 45,000**" or "**PKR 1.2M**").

3. RISK-BASED PROPOSALS & MUTATIONS:
   - You NEVER modify database records silently or directly.
   - When the Owner instructs you to create a product, change a price, adjust stock, dispatch an order, cancel an order, or add a category, you MUST call the corresponding proposal tool (propose_create_product, propose_update_price, propose_adjust_stock, propose_order_status_update, propose_order_cancellation, propose_create_category).
   - Explain the proposed action clearly to the Owner so they can review the interactive Proposal Card on their screen.

4. SEPARATION OF VERIFIED INTERNAL DATA VS EXTERNAL MARKET KNOWLEDGE:
   - Clearly distinguish between verified store database data and general market automotive intelligence.
   - Label verified store metrics as "**Verified Store Data**".

5. RICH EXECUTIVE FORMATTING:
   - Use clean tables, bold numbers, and bullet points.
   - Highlight actionable insights (e.g., 📈 Growth, ⚠️ Low Stock Alert, 💡 Recommendation).
`

/**
 * Tool Declarations for Gemini Function Calling
 */
const STORE_MANAGER_TOOLS = [
  {
    name: 'get_sales_summary',
    description: 'Get comprehensive sales and revenue analytics for AutoGenuine across today, this week, this month, or all-time.',
    parameters: {
      type: 'OBJECT',
      properties: {
        period: {
          type: 'STRING',
          enum: ['today', 'this_week', 'this_month', 'last_month', 'all_time'],
          description: 'The time period to summarize sales for.',
        },
      },
      required: ['period'],
    },
  },
  {
    name: 'compare_sales_periods',
    description: 'Compare sales, revenue growth, and order volume between two time periods (e.g. this_month vs last_month, this_week vs last_week, today vs yesterday).',
    parameters: {
      type: 'OBJECT',
      properties: {
        currentPeriod: {
          type: 'STRING',
          enum: ['today', 'this_week', 'this_month'],
          description: 'The current period to evaluate.',
        },
        previousPeriod: {
          type: 'STRING',
          enum: ['yesterday', 'last_week', 'last_month'],
          description: 'The baseline period to compare against.',
        },
      },
      required: ['currentPeriod', 'previousPeriod'],
    },
  },
  {
    name: 'get_top_selling_products',
    description: 'Retrieve the best-selling OEM parts and products ranked by units sold and revenue generation.',
    parameters: {
      type: 'OBJECT',
      properties: {
        limit: {
          type: 'NUMBER',
          description: 'Number of top products to retrieve (default: 5, max: 20).',
        },
      },
    },
  },
  {
    name: 'get_slow_moving_products',
    description: 'Identify slow-moving inventory with high stock and zero or declining sales over the last 30 to 60 days.',
    parameters: {
      type: 'OBJECT',
      properties: {
        daysWithoutSales: {
          type: 'NUMBER',
          description: 'Threshold days without sales (default: 30).',
        },
        limit: {
          type: 'NUMBER',
          description: 'Max items to return (default: 10).',
        },
      },
    },
  },
  {
    name: 'get_category_performance',
    description: 'Get revenue and sales distribution broken down by product categories (e.g. Brakes, Engine, Suspension, Body Parts, Lighting).',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'get_inventory_health',
    description: 'Retrieve store inventory health including low stock items (stock <= 5), out of stock items, and restocking recommendations.',
    parameters: {
      type: 'OBJECT',
      properties: {
        threshold: {
          type: 'NUMBER',
          description: 'Stock threshold for low stock alert (default: 5).',
        },
      },
    },
  },
  {
    name: 'get_order_summary',
    description: 'Retrieve a list of orders filtered by status (pending, processing, packed, dispatched, delivered, cancelled) with customer names and totals.',
    parameters: {
      type: 'OBJECT',
      properties: {
        status: {
          type: 'STRING',
          enum: ['all', 'pending', 'processing', 'dispatched', 'out_for_delivery', 'delivered', 'cancelled'],
          description: 'Filter orders by status.',
        },
        limit: {
          type: 'NUMBER',
          description: 'Number of orders to retrieve (default: 10).',
        },
      },
    },
  },
  {
    name: 'get_order_details',
    description: 'Get complete line items, customer details, payment info, and fulfillment history for a specific order reference code or ID.',
    parameters: {
      type: 'OBJECT',
      properties: {
        orderRef: {
          type: 'STRING',
          description: 'Order reference number (e.g. ORD-1024 or MongoDB ID).',
        },
      },
      required: ['orderRef'],
    },
  },
  {
    name: 'search_products',
    description: 'Search catalog products by part name, vehicle fitment, SKU, or category.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Search keyword (e.g. "Camry Brake Pad", "Civic", "OEM Oil Filter").',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'propose_create_product',
    description: 'Propose creating a new OEM part / product listing. Generates a structured Product Draft that the Owner must approve before publishing.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Product title (e.g. "Genuine Front Brake Pads for Toyota Camry 2018-2024").' },
        categorySlug: { type: 'STRING', description: 'Category slug (e.g. "brakes", "engine", "suspension", "filters").' },
        price: { type: 'NUMBER', description: 'Price in PKR.' },
        stock: { type: 'NUMBER', description: 'Initial inventory quantity.' },
        fits: { type: 'STRING', description: 'Vehicle fitment details (e.g. "Toyota Camry 2.5L 2018-2024").' },
        image: { type: 'STRING', description: 'Product image URL.' },
        badge: { type: 'STRING', description: 'Badge (e.g. "OEM", "GENUINE", "POPULAR").' },
        sku: { type: 'STRING', description: 'SKU code (e.g. "TOY-BRK-04465").' },
        oemNumber: { type: 'STRING', description: 'Manufacturer OEM Part Number.' },
        description: { type: 'STRING', description: 'Professional product description.' },
        seoTitle: { type: 'STRING', description: 'SEO optimized title.' },
        seoDescription: { type: 'STRING', description: 'SEO meta description.' },
        tags: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Search tags.' },
      },
      required: ['name', 'categorySlug', 'price', 'stock'],
    },
  },
  {
    name: 'propose_update_price',
    description: 'Propose updating the price of an existing product. Creates a price change proposal card for Owner approval.',
    parameters: {
      type: 'OBJECT',
      properties: {
        slug: { type: 'STRING', description: 'The product slug to update.' },
        newPrice: { type: 'NUMBER', description: 'The new proposed price in PKR.' },
        reason: { type: 'STRING', description: 'Business justification for price adjustment.' },
      },
      required: ['slug', 'newPrice'],
    },
  },
  {
    name: 'propose_adjust_stock',
    description: 'Propose adjusting or restocking inventory for a specific product. Creates a stock update proposal card for Owner approval.',
    parameters: {
      type: 'OBJECT',
      properties: {
        slug: { type: 'STRING', description: 'The product slug to restock.' },
        stockAddition: { type: 'NUMBER', description: 'Units to add to current inventory (e.g. +10).' },
        reason: { type: 'STRING', description: 'Reason for restocking.' },
      },
      required: ['slug', 'stockAddition'],
    },
  },
  {
    name: 'propose_order_status_update',
    description: 'Propose updating an order status (e.g. marking as dispatched, packed, or delivered). Creates an order action proposal card for Owner approval.',
    parameters: {
      type: 'OBJECT',
      properties: {
        orderRef: { type: 'STRING', description: 'The order reference (e.g. ORD-1024).' },
        newStatus: {
          type: 'STRING',
          enum: ['processing', 'packed', 'dispatched', 'out_for_delivery', 'shipped', 'delivered'],
          description: 'The target order status.',
        },
        courierName: { type: 'STRING', description: 'Courier company (TCS, Leopards, Trax, etc.).' },
        trackingNumber: { type: 'STRING', description: 'Courier tracking number if available.' },
        note: { type: 'STRING', description: 'Fulfillment note.' },
      },
      required: ['orderRef', 'newStatus'],
    },
  },
  {
    name: 'propose_order_cancellation',
    description: 'Propose cancelling an order with validation. Creates a cancellation proposal card for Owner approval.',
    parameters: {
      type: 'OBJECT',
      properties: {
        orderRef: { type: 'STRING', description: 'The order reference to cancel.' },
        cancellationReason: { type: 'STRING', description: 'Detailed cancellation reason.' },
      },
      required: ['orderRef', 'cancellationReason'],
    },
  },
  {
    name: 'propose_create_category',
    description: 'Propose adding a new product category structure to the store catalog.',
    parameters: {
      type: 'OBJECT',
      properties: {
        label: { type: 'STRING', description: 'Display name of the category (e.g. "Exhaust Systems").' },
        slug: { type: 'STRING', description: 'URL slug (e.g. "exhaust-systems").' },
        icon: { type: 'STRING', description: 'Lucide icon name (e.g. "Flame", "Car", "Zap", "Layers", "Wrench").' },
        description: { type: 'STRING', description: 'Brief category description.' },
      },
      required: ['label', 'slug'],
    },
  },
  {
    name: 'propose_bulk_import_products',
    description: 'Propose importing multiple automotive products/parts from a spreadsheet (CSV/Excel) or batch list. Creates a Bulk Import Proposal for Owner review.',
    parameters: {
      type: 'OBJECT',
      properties: {
        products: {
          type: 'ARRAY',
          description: 'List of product objects to import.',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING', description: 'Product title' },
              categorySlug: { type: 'STRING', description: 'Category slug (e.g. brakes, engine, suspension, filters, lighting)' },
              price: { type: 'NUMBER', description: 'Price in PKR' },
              stock: { type: 'NUMBER', description: 'Stock quantity' },
              fits: { type: 'STRING', description: 'Vehicle fitment' },
              sku: { type: 'STRING', description: 'SKU number' },
              oemNumber: { type: 'STRING', description: 'OEM part number' },
              image: { type: 'STRING', description: 'Image URL if available' },
              badge: { type: 'STRING', description: 'Badge (OEM, GENUINE)' },
            },
            required: ['name', 'price'],
          },
        },
        sourceFileName: { type: 'STRING', description: 'Name of the uploaded file if provided.' },
      },
      required: ['products'],
    },
  },
  {
    name: 'generate_executive_business_report',
    description: 'Generate a structured executive business health report summarizing total revenue, growth rate, top performing categories, inventory risk, and strategic recommendations.',
    parameters: {
      type: 'OBJECT',
      properties: {
        timeFrame: {
          type: 'STRING',
          enum: ['daily', 'weekly', 'monthly', 'all_time'],
          description: 'Report time frame.',
        },
      },
    },
  },
]

/**
 * Tool Execution Implementations
 */
export async function executeStoreTool(toolName, args, user) {
  try {
    switch (toolName) {
      case 'get_sales_summary': {
        const { period = 'this_month' } = args
        const now = new Date()
        let startDate = new Date(0)

        if (period === 'today') {
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        } else if (period === 'this_week') {
          const day = now.getDay()
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day)
        } else if (period === 'this_month') {
          startDate = new Date(now.getFullYear(), now.getMonth(), 1)
        } else if (period === 'last_month') {
          startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
          const endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)
          const orders = await Order.find({
            status: { $ne: 'cancelled' },
            createdAt: { $gte: startDate, $lte: endDate },
          }).lean()
          const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0)
          const avgOrderValue = orders.length > 0 ? Math.round(totalRevenue / orders.length) : 0
          return {
            period: 'Last Month',
            totalOrders: orders.length,
            totalRevenuePKR: totalRevenue,
            averageOrderValuePKR: avgOrderValue,
            currency: 'PKR',
          }
        }

        const orders = await Order.find({
          status: { $ne: 'cancelled' },
          createdAt: { $gte: startDate },
        }).lean()

        const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0)
        const avgOrderValue = orders.length > 0 ? Math.round(totalRevenue / orders.length) : 0

        // Status breakdown
        const statusMap = {}
        for (const o of orders) {
          statusMap[o.status] = (statusMap[o.status] || 0) + 1
        }

        return {
          period: period.replace('_', ' ').toUpperCase(),
          totalOrders: orders.length,
          totalRevenuePKR: totalRevenue,
          averageOrderValuePKR: avgOrderValue,
          statusBreakdown: statusMap,
          currency: 'PKR',
        }
      }

      case 'compare_sales_periods': {
        const { currentPeriod = 'this_month', previousPeriod = 'last_month' } = args
        const now = new Date()

        let curStart = new Date(now.getFullYear(), now.getMonth(), 1)
        let prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
        let prevEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)

        if (currentPeriod === 'today') {
          curStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
          prevStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
          prevEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59)
        } else if (currentPeriod === 'this_week') {
          const day = now.getDay()
          curStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day)
          prevStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day - 7)
          prevEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day, 0, 0, 0)
        }

        const [curOrders, prevOrders] = await Promise.all([
          Order.find({ status: { $ne: 'cancelled' }, createdAt: { $gte: curStart } }).lean(),
          Order.find({ status: { $ne: 'cancelled' }, createdAt: { $gte: prevStart, $lte: prevEnd } }).lean(),
        ])

        const curRev = curOrders.reduce((sum, o) => sum + (o.total || 0), 0)
        const prevRev = prevOrders.reduce((sum, o) => sum + (o.total || 0), 0)
        const growthRate = prevRev > 0 ? (((curRev - prevRev) / prevRev) * 100).toFixed(1) : curRev > 0 ? '+100.0' : '0.0'

        return {
          currentPeriod: {
            name: currentPeriod.replace('_', ' '),
            orders: curOrders.length,
            revenuePKR: curRev,
          },
          previousPeriod: {
            name: previousPeriod.replace('_', ' '),
            orders: prevOrders.length,
            revenuePKR: prevRev,
          },
          growthRatePercent: `${growthRate}%`,
          revenueDifferencePKR: curRev - prevRev,
          trend: curRev >= prevRev ? 'GROWING' : 'DECLINING',
        }
      }

      case 'get_top_selling_products': {
        const limit = Math.min(Number(args.limit) || 5, 20)
        const topAgg = await Order.aggregate([
          { $match: { status: { $ne: 'cancelled' } } },
          { $unwind: '$items' },
          {
            $group: {
              _id: '$items.partSlug',
              name: { $first: '$items.name' },
              unitsSold: { $sum: '$items.qty' },
              totalRevenue: { $sum: { $multiply: ['$items.price', '$items.qty'] } },
            },
          },
          { $sort: { unitsSold: -1, totalRevenue: -1 } },
          { $limit: limit },
        ])

        // Lookup current stock
        const slugs = topAgg.map((t) => t._id)
        const parts = await Part.find({ slug: { $in: slugs } }).select('slug stock categorySlug price').lean()
        const partMap = new Map(parts.map((p) => [p.slug, p]))

        const results = topAgg.map((t, idx) => ({
          rank: idx + 1,
          slug: t._id,
          name: t.name,
          unitsSold: t.unitsSold,
          revenuePKR: t.totalRevenue,
          currentStock: partMap.get(t._id)?.stock ?? 'N/A',
          category: partMap.get(t._id)?.categorySlug || 'general',
        }))

        return { topSellingProducts: results }
      }

      case 'get_slow_moving_products': {
        const thresholdDays = Number(args.daysWithoutSales) || 30
        const limit = Math.min(Number(args.limit) || 10, 30)
        const cutoffDate = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000)

        // Find parts that have NOT appeared in orders since cutoffDate
        const recentOrders = await Order.find({ createdAt: { $gte: cutoffDate }, status: { $ne: 'cancelled' } }).select('items').lean()
        const activePartSlugs = new Set()
        for (const o of recentOrders) {
          for (const item of o.items || []) {
            if (item.partSlug) activePartSlugs.add(item.partSlug)
          }
        }

        const slowParts = await Part.find({
          slug: { $nin: Array.from(activePartSlugs) },
          stock: { $gt: 0 },
          active: true,
        })
          .sort({ stock: -1 })
          .limit(limit)
          .lean()

        const slowList = slowParts.map((p) => ({
          slug: p.slug,
          name: p.name,
          category: p.categorySlug,
          pricePKR: p.price,
          availableStock: p.stock,
          daysWithoutSales: `>${thresholdDays} days`,
          suggestedAction: p.stock > 10 ? 'Apply 15-20% discount or feature on homepage' : 'Monitor or bundle with popular items',
        }))

        return {
          thresholdDays,
          slowMovingProductsCount: slowList.length,
          slowMovingProducts: slowList,
        }
      }

      case 'get_category_performance': {
        const categoryStats = await Order.aggregate([
          { $match: { status: { $ne: 'cancelled' } } },
          { $unwind: '$items' },
          {
            $lookup: {
              from: 'parts',
              localField: 'items.partSlug',
              foreignField: 'slug',
              as: 'partDetails',
            },
          },
          {
            $group: {
              _id: { $ifNull: [{ $arrayElemAt: ['$partDetails.categorySlug', 0] }, 'other'] },
              unitsSold: { $sum: '$items.qty' },
              revenue: { $sum: { $multiply: ['$items.price', '$items.qty'] } },
              orderCount: { $sum: 1 },
            },
          },
          { $sort: { revenue: -1 } },
        ])

        const totalRev = categoryStats.reduce((sum, c) => sum + c.revenue, 0)

        const enriched = categoryStats.map((c) => ({
          category: c._id,
          revenuePKR: c.revenue,
          unitsSold: c.unitsSold,
          revenueShare: totalRev > 0 ? `${((c.revenue / totalRev) * 100).toFixed(1)}%` : '0%',
        }))

        return { categoryPerformance: enriched }
      }

      case 'get_inventory_health': {
        const threshold = Number(args.threshold) || 5
        const [lowStockParts, outOfStockParts, totalPartsCount] = await Promise.all([
          Part.find({ stock: { $gt: 0, $lte: threshold }, active: true }).lean(),
          Part.find({ stock: 0, active: true }).lean(),
          Part.countDocuments({ active: true }),
        ])

        const inventoryValueAgg = await Part.aggregate([
          { $match: { active: true } },
          { $group: { _id: null, totalVal: { $sum: { $multiply: ['$price', '$stock'] } }, totalItems: { $sum: '$stock' } } },
        ])

        const totalVal = inventoryValueAgg[0]?.totalVal || 0
        const totalItemsInStock = inventoryValueAgg[0]?.totalItems || 0

        return {
          totalCatalogProducts: totalPartsCount,
          totalUnitsInStock: totalItemsInStock,
          totalInventoryValuePKR: totalVal,
          lowStockCount: lowStockParts.length,
          outOfStockCount: outOfStockParts.length,
          lowStockAlerts: lowStockParts.map((p) => ({
            slug: p.slug,
            name: p.name,
            currentStock: p.stock,
            pricePKR: p.price,
            recommendedRestockQty: Math.max(10, (threshold * 3) - p.stock),
          })),
          outOfStockAlerts: outOfStockParts.map((p) => ({
            slug: p.slug,
            name: p.name,
            pricePKR: p.price,
          })),
        }
      }

      case 'get_order_summary': {
        const { status = 'all', limit = 10 } = args
        const filter = {}
        if (status !== 'all') filter.status = status

        const orders = await Order.find(filter)
          .sort({ createdAt: -1 })
          .limit(Math.min(limit, 30))
          .lean()

        return {
          count: orders.length,
          orders: orders.map((o) => ({
            orderId: o._id,
            orderRef: o._id.toString().slice(-6).toUpperCase(),
            customerName: o.customerName || 'Customer',
            customerPhone: o.customerPhone,
            city: o.city,
            totalPKR: o.total,
            status: o.status,
            paymentMethod: o.paymentMethod,
            paymentStatus: o.paymentStatus,
            itemsCount: o.items?.length || 0,
            date: o.createdAt,
          })),
        }
      }

      case 'get_order_details': {
        const { orderRef } = args
        let order = null
        if (orderRef.length === 24) {
          order = await Order.findById(orderRef).lean()
        }
        if (!order) {
          const allOrders = await Order.find().sort({ createdAt: -1 }).limit(100).lean()
          order = allOrders.find((o) => o._id.toString().slice(-6).toUpperCase() === orderRef.toUpperCase() || o._id.toString() === orderRef)
        }

        if (!order) return { error: `Order #${orderRef} not found in database.` }

        return {
          orderId: order._id,
          orderRef: order._id.toString().slice(-6).toUpperCase(),
          status: order.status,
          customer: {
            name: order.customerName,
            email: order.customerEmail,
            phone: order.customerPhone,
            address: order.shippingAddress,
            city: order.city,
          },
          items: order.items,
          totalPKR: order.total,
          payment: {
            method: order.paymentMethod,
            status: order.paymentStatus,
            paidAt: order.paidAt,
          },
          vehicleInfo: order.vehicleInfo,
          notes: order.notes,
          createdAt: order.createdAt,
        }
      }

      case 'search_products': {
        const { query } = args
        const regex = new RegExp(query.trim(), 'i')
        const parts = await Part.find({
          $or: [{ name: regex }, { fits: regex }, { slug: regex }, { sku: regex }, { oemNumber: regex }],
        })
          .limit(10)
          .lean()

        return {
          matchesCount: parts.length,
          products: parts.map((p) => ({
            slug: p.slug,
            name: p.name,
            category: p.categorySlug,
            pricePKR: p.price,
            stock: p.stock,
            fits: p.fits,
            badge: p.badge,
            sku: p.sku,
            oemNumber: p.oemNumber,
          })),
        }
      }

      case 'propose_create_product': {
        // Generate auto slug if not provided
        let slug = args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const existing = await Part.findOne({ slug })
        if (existing) {
          slug = `${slug}-${Date.now().toString().slice(-4)}`
        }

        const draftPayload = {
          slug,
          name: args.name,
          categorySlug: args.categorySlug,
          price: Number(args.price),
          stock: Number(args.stock) || 10,
          fits: args.fits || '',
          image: args.image || '',
          badge: args.badge || 'GENUINE',
          sku: args.sku || `SKU-${Date.now().toString().slice(-6)}`,
          oemNumber: args.oemNumber || '',
          discount: 0,
          featured: false,
          popular: false,
          active: true,
          description: args.description || `Genuine OEM ${args.name} engineered for precision fit and reliability.`,
          seoTitle: args.seoTitle || `${args.name} | AutoGenuine Pakistan`,
          seoDescription: args.seoDescription || `Buy 100% genuine ${args.name} at best price with nationwide express delivery.`,
          tags: args.tags || [args.categorySlug, 'oem', 'genuine'],
        }

        const action = await AIStoreAction.create({
          actionType: 'create_product',
          title: `Create New Product: ${args.name}`,
          description: `Add "${args.name}" to category "${args.categorySlug}" at Rs ${Number(args.price).toLocaleString()} with ${args.stock} units in stock.`,
          riskLevel: 'medium',
          targetType: 'part',
          targetId: slug,
          payload: draftPayload,
          status: 'pending_approval',
          proposedBy: user?._id,
        })

        return {
          proposalCreated: true,
          actionId: action._id,
          productDraft: draftPayload,
          message: `Product draft for "${args.name}" generated successfully. Owner review and confirmation required to publish to store.`,
        }
      }

      case 'propose_update_price': {
        const { slug, newPrice, reason = '' } = args
        const part = await Part.findOne({ slug }).lean()
        if (!part) return { error: `Product with slug "${slug}" does not exist.` }

        const action = await AIStoreAction.create({
          actionType: 'update_product_price',
          title: `Update Price: ${part.name}`,
          description: `Change price from Rs ${part.price.toLocaleString()} to Rs ${Number(newPrice).toLocaleString()}. Reason: ${reason || 'Pricing adjustment'}`,
          riskLevel: 'medium',
          targetType: 'part',
          targetId: slug,
          previousState: { price: part.price },
          payload: { slug, oldPrice: part.price, newPrice: Number(newPrice), reason },
          status: 'pending_approval',
          proposedBy: user?._id,
        })

        return {
          proposalCreated: true,
          actionId: action._id,
          product: part.name,
          oldPricePKR: part.price,
          newPricePKR: Number(newPrice),
          message: `Price update proposal for "${part.name}" created. Awaiting owner approval.`,
        }
      }

      case 'propose_adjust_stock': {
        const { slug, stockAddition, reason = '' } = args
        const part = await Part.findOne({ slug }).lean()
        if (!part) return { error: `Product with slug "${slug}" does not exist.` }

        const nextStock = Math.max(0, part.stock + Number(stockAddition))

        const action = await AIStoreAction.create({
          actionType: 'update_product_stock',
          title: `Restock Inventory: ${part.name}`,
          description: `Adjust stock by ${stockAddition > 0 ? `+${stockAddition}` : stockAddition} units (from ${part.stock} to ${nextStock}). Reason: ${reason || 'Inventory restock'}`,
          riskLevel: 'medium',
          targetType: 'part',
          targetId: slug,
          previousState: { stock: part.stock },
          payload: { slug, oldStock: part.stock, stockAddition: Number(stockAddition), newStock: nextStock, reason },
          status: 'pending_approval',
          proposedBy: user?._id,
        })

        return {
          proposalCreated: true,
          actionId: action._id,
          product: part.name,
          currentStock: part.stock,
          stockAddition,
          resultingStock: nextStock,
          message: `Stock restock proposal created for "${part.name}". Awaiting owner approval.`,
        }
      }

      case 'propose_order_status_update': {
        const { orderRef, newStatus, courierName = 'TCS Express', trackingNumber = '', note = '' } = args
        let order = null
        if (orderRef.length === 24) order = await Order.findById(orderRef)
        if (!order) {
          const allOrders = await Order.find()
          order = allOrders.find((o) => o._id.toString().slice(-6).toUpperCase() === orderRef.toUpperCase() || o._id.toString() === orderRef)
        }

        if (!order) return { error: `Order #${orderRef} not found.` }

        const action = await AIStoreAction.create({
          actionType: 'update_order_status',
          title: `Update Order #${order._id.toString().slice(-6).toUpperCase()} to ${newStatus.toUpperCase()}`,
          description: `Transition order status from "${order.status}" to "${newStatus}" (${courierName} tracking: ${trackingNumber || 'Auto-generated'}).`,
          riskLevel: newStatus === 'cancelled' ? 'high' : 'medium',
          targetType: 'order',
          targetId: order._id.toString(),
          previousState: { status: order.status },
          payload: {
            orderId: order._id.toString(),
            orderRef: order._id.toString().slice(-6).toUpperCase(),
            oldStatus: order.status,
            newStatus,
            courierName,
            trackingNumber: trackingNumber || `TRK-${Date.now().toString().slice(-6)}`,
            note,
          },
          status: 'pending_approval',
          proposedBy: user?._id,
        })

        return {
          proposalCreated: true,
          actionId: action._id,
          orderRef: order._id.toString().slice(-6).toUpperCase(),
          currentStatus: order.status,
          proposedStatus: newStatus,
          message: `Order status transition proposal created for #${order._id.toString().slice(-6).toUpperCase()}. Awaiting owner confirmation.`,
        }
      }

      case 'propose_order_cancellation': {
        const { orderRef, cancellationReason = '' } = args
        let order = null
        if (orderRef.length === 24) order = await Order.findById(orderRef)
        if (!order) {
          const allOrders = await Order.find()
          order = allOrders.find((o) => o._id.toString().slice(-6).toUpperCase() === orderRef.toUpperCase() || o._id.toString() === orderRef)
        }

        if (!order) return { error: `Order #${orderRef} not found.` }
        if (order.status === 'delivered') return { error: `Order #${orderRef} is already delivered and cannot be cancelled.` }

        const action = await AIStoreAction.create({
          actionType: 'cancel_order',
          title: `Cancel Order #${order._id.toString().slice(-6).toUpperCase()}`,
          description: `Cancel order for ${order.customerName} (Total: Rs ${order.total.toLocaleString()}). Reason: ${cancellationReason || 'Owner initiated cancellation'}`,
          riskLevel: 'high',
          targetType: 'order',
          targetId: order._id.toString(),
          previousState: { status: order.status },
          payload: {
            orderId: order._id.toString(),
            orderRef: order._id.toString().slice(-6).toUpperCase(),
            oldStatus: order.status,
            cancellationReason,
          },
          status: 'pending_approval',
          proposedBy: user?._id,
        })

        return {
          proposalCreated: true,
          actionId: action._id,
          orderRef: order._id.toString().slice(-6).toUpperCase(),
          customer: order.customerName,
          totalPKR: order.total,
          message: `High-risk cancellation proposal created for Order #${order._id.toString().slice(-6).toUpperCase()}. Strict owner confirmation required.`,
        }
      }

      case 'propose_create_category': {
        const { label, slug, icon = 'Package', description = '' } = args
        const cleanSlug = (slug || label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const existing = await Category.findOne({ slug: cleanSlug })
        if (existing) {
          return { error: `Category with slug "${cleanSlug}" already exists in store.` }
        }

        const action = await AIStoreAction.create({
          actionType: 'create_category',
          title: `Add Category: ${label}`,
          description: `Create new store catalog category "${label}" (${cleanSlug}) with icon "${icon}".`,
          riskLevel: 'medium',
          targetType: 'category',
          targetId: cleanSlug,
          payload: { label, slug: cleanSlug, icon, description },
          status: 'pending_approval',
          proposedBy: user?._id,
        })

        return {
          proposalCreated: true,
          actionId: action._id,
          categoryName: label,
          slug: cleanSlug,
          message: `Category proposal created for "${label}". Awaiting owner approval.`,
        }
      }

      case 'propose_bulk_import_products': {
        const { products = [], sourceFileName = 'Spreadsheet Import' } = args
        if (!Array.isArray(products) || products.length === 0) {
          return { error: 'No products found to import in spreadsheet data.' }
        }

        const sanitizedProducts = products.map((p, idx) => {
          const rawSlug = (p.name || `item-${idx + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
          return {
            slug: rawSlug || `part-${Date.now()}-${idx}`,
            name: p.name || 'Unnamed Automotive Part',
            categorySlug: (p.categorySlug || 'general').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            price: Number(p.price) || 5000,
            stock: Number(p.stock) || 10,
            fits: p.fits || '',
            sku: p.sku || `SKU-${Date.now().toString().slice(-4)}-${idx + 1}`,
            oemNumber: p.oemNumber || '',
            image: p.image || '',
            badge: p.badge || 'GENUINE',
            active: true,
          }
        })

        const action = await AIStoreAction.create({
          actionType: 'bulk_import_products',
          title: `Bulk Import: ${sanitizedProducts.length} Products from ${sourceFileName}`,
          description: `Import batch catalog spreadsheet with ${sanitizedProducts.length} OEM automotive items.`,
          riskLevel: 'medium',
          targetType: 'part',
          payload: {
            sourceFileName,
            itemCount: sanitizedProducts.length,
            products: sanitizedProducts,
          },
          status: 'pending_approval',
          proposedBy: user?._id,
        })

        return {
          proposalCreated: true,
          actionId: action._id,
          itemCount: sanitizedProducts.length,
          preview: sanitizedProducts.slice(0, 5),
          message: `Bulk import proposal created for ${sanitizedProducts.length} items from ${sourceFileName}. Awaiting owner confirmation to publish to store catalog.`,
        }
      }

      case 'generate_executive_business_report': {
        const { timeFrame = 'monthly' } = args
        const now = new Date()
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)

        const [curOrders, prevOrders, parts, categories] = await Promise.all([
          Order.find({ status: { $ne: 'cancelled' }, createdAt: { $gte: startOfMonth } }).lean(),
          Order.find({ status: { $ne: 'cancelled' }, createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } }).lean(),
          Part.find({ active: true }).lean(),
          Category.find().lean(),
        ])

        const curRevenue = curOrders.reduce((sum, o) => sum + (o.total || 0), 0)
        const prevRevenue = prevOrders.reduce((sum, o) => sum + (o.total || 0), 0)
        const growth = prevRevenue > 0 ? (((curRevenue - prevRevenue) / prevRevenue) * 100).toFixed(1) : '+100.0'

        const lowStockCount = parts.filter((p) => p.stock > 0 && p.stock <= 5).length
        const outOfStockCount = parts.filter((p) => p.stock === 0).length

        return {
          reportPeriod: 'Current Month Executive Audit',
          financialPerformance: {
            revenueThisMonthPKR: curRevenue,
            revenueLastMonthPKR: prevRevenue,
            growthRate: `${growth}%`,
            ordersThisMonth: curOrders.length,
            averageOrderValuePKR: curOrders.length > 0 ? Math.round(curRevenue / curOrders.length) : 0,
          },
          inventoryHealth: {
            totalActiveProducts: parts.length,
            lowStockAlerts: lowStockCount,
            outOfStockAlerts: outOfStockCount,
            totalCategories: categories.length,
          },
          executiveSummary: `AutoGenuine is experiencing ${curRevenue >= prevRevenue ? 'positive revenue growth' : 'a slight revenue contraction'} with PKR ${curRevenue.toLocaleString()} in sales this month. ${lowStockCount} items need restocking to prevent revenue loss.`,
        }
      }

      default:
        return { error: `Unrecognized store manager tool: ${toolName}` }
    }
  } catch (err) {
    console.error(`Error executing tool ${toolName}:`, err)
    return { error: `Failed to execute ${toolName}: ${err.message}` }
  }
}

/**
 * Execute Gemini Multi-turn Function Calling Loop
 */
export async function processStoreManagerChat({ prompt, imageUrl = '', conversationHistory = [], user }) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in backend environment.')
  }

  // Cooldown check
  if (Date.now() < quotaCooldownUntil) {
    throw new Error('Gemini API is currently resting due to temporary rate-limits. Please retry in a few moments.')
  }

  // Format conversation history for Gemini API
  const contents = []

  // Add previous turns
  for (const turn of conversationHistory.slice(-10)) {
    if (turn.role === 'user') {
      const parts = [{ text: turn.text }]
      if (turn.imageUrl) {
        parts.push({ text: `[Attached image: ${turn.imageUrl}]` })
      }
      contents.push({ role: 'user', parts })
    } else if (turn.role === 'assistant') {
      contents.push({ role: 'model', parts: [{ text: turn.text || 'Understood.' }] })
    }
  }

  // Add current user prompt + image if provided
  const currentParts = []
  if (imageUrl) {
    currentParts.push({
      text: `Analyze the attached image and assist with the store owner request: "${prompt || 'Extract product details and create a listing draft from this image.'}"\nImage URL: ${imageUrl}`,
    })
  } else {
    currentParts.push({ text: prompt })
  }
  contents.push({ role: 'user', parts: currentParts })

  const toolsUsed = []
  const actionProposals = []
  let productDraft = null
  let finalAssistantText = ''
  let iteration = 0
  const maxIterations = 5

  while (iteration < maxIterations) {
    iteration++

    const payload = {
      contents,
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      tools: [{ functionDeclarations: STORE_MANAGER_TOOLS }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
      },
    }

    let responseData = null
    let selectedModel = CANDIDATE_MODELS[0]

    for (const model of CANDIDATE_MODELS) {
      try {
        const res = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })

        if (res.status === 429) {
          quotaCooldownUntil = Date.now() + 1500
          await new Promise((r) => setTimeout(r, 1000))
          continue
        }

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}))
          console.warn(`Gemini model ${model} failed with ${res.status}:`, errBody.error?.message)
          continue
        }

        responseData = await res.json()
        selectedModel = model
        break
      } catch (err) {
        console.warn(`Attempt with ${model} failed:`, err.message)
      }
    }

    if (!responseData || !responseData.candidates || responseData.candidates.length === 0) {
      throw new Error('Gemini API was unable to generate a response. Please try again.')
    }

    const candidate = responseData.candidates[0]
    const modelParts = candidate.content?.parts || []

    // Collect text output
    for (const part of modelParts) {
      if (part.text) {
        finalAssistantText += (finalAssistantText ? '\n' : '') + part.text
      }
    }

    // Check if model made function calls
    const functionCalls = modelParts.filter((p) => p.functionCall).map((p) => p.functionCall)

    if (functionCalls.length === 0) {
      // Model finished turn
      break
    }

    // Append model's response to history
    contents.push({ role: 'model', parts: modelParts })

    // Execute each tool call and collect results
    const functionResponses = []
    for (const fc of functionCalls) {
      const toolName = fc.name
      const toolArgs = fc.args || {}
      toolsUsed.push(toolName)

      console.log(`[AI Store Manager] Invoking tool: ${toolName}`, toolArgs)
      const toolResult = await executeStoreTool(toolName, toolArgs, user)

      if (toolResult.proposalCreated && toolResult.actionId) {
        const actionDoc = await AIStoreAction.findById(toolResult.actionId).lean()
        if (actionDoc) {
          actionProposals.push({
            actionId: actionDoc._id,
            actionType: actionDoc.actionType,
            title: actionDoc.title,
            description: actionDoc.description,
            riskLevel: actionDoc.riskLevel,
            targetType: actionDoc.targetType,
            targetId: actionDoc.targetId,
            payload: actionDoc.payload,
            status: actionDoc.status,
          })
        }
        if (toolResult.productDraft) {
          productDraft = toolResult.productDraft
        }
      }

      functionResponses.push({
        functionResponse: {
          name: toolName,
          response: { result: toolResult },
        },
      })
    }

    // Provide tool results back to Gemini in the conversation
    contents.push({
      role: 'user',
      parts: functionResponses,
    })
  }

  return {
    text: finalAssistantText || 'I have completed your analysis request.',
    toolsUsed: Array.from(new Set(toolsUsed)),
    actionProposals,
    productDraft,
  }
}

/**
 * Execute an Approved Action
 */
export async function executeApprovedStoreAction(actionId, user) {
  const action = await AIStoreAction.findById(actionId)
  if (!action) {
    throw new Error('Action proposal not found or has expired.')
  }

  if (action.status === 'executed') {
    return { success: true, alreadyExecuted: true, action }
  }

  if (action.status === 'rejected') {
    throw new Error('This action proposal was previously rejected.')
  }

  try {
    let executionResult = null

    switch (action.actionType) {
      case 'create_product': {
        const p = action.payload
        const createdPart = await Part.create({
          slug: p.slug,
          categorySlug: p.categorySlug,
          badge: p.badge || 'GENUINE',
          name: p.name,
          fits: p.fits || '',
          price: Number(p.price),
          image: p.image || '',
          stock: Number(p.stock) || 10,
          sku: p.sku || '',
          oemNumber: p.oemNumber || '',
          discount: Number(p.discount) || 0,
          featured: Boolean(p.featured),
          popular: Boolean(p.popular),
          active: true,
        })
        executionResult = createdPart.toObject()
        break
      }

      case 'update_product_price': {
        const { slug, newPrice } = action.payload
        const part = await Part.findOne({ slug })
        if (!part) throw new Error(`Product ${slug} not found.`)
        const targetPrice = Number(newPrice)
        const orig = part.originalPrice && part.originalPrice > targetPrice ? part.originalPrice : Math.round(targetPrice * 1.14)
        const disc = Math.round((1 - targetPrice / orig) * 100)
        part.price = targetPrice
        part.originalPrice = orig
        part.discount = disc
        await part.save()
        executionResult = part.toObject()
        break
      }

      case 'update_product_stock': {
        const { slug, newStock } = action.payload
        const updated = await Part.findOneAndUpdate(
          { slug },
          { $set: { stock: Number(newStock) } },
          { new: true }
        )
        if (!updated) throw new Error(`Product ${slug} not found.`)
        executionResult = updated.toObject()
        break
      }

      case 'update_order_status': {
        const { orderId, newStatus, courierName, trackingNumber, note } = action.payload
        const order = await Order.findById(orderId)
        if (!order) throw new Error('Order not found.')

        order.status = newStatus
        if (note) order.notes = (order.notes ? `${order.notes}\n` : '') + `[AI Manager Action: ${note}]`
        await order.save()
        executionResult = order.toObject()
        break
      }

      case 'cancel_order': {
        const { orderId, cancellationReason } = action.payload
        const order = await Order.findById(orderId)
        if (!order) throw new Error('Order not found.')

        order.status = 'cancelled'
        order.cancellationReason = cancellationReason || 'Cancelled by Store Owner via AI Store Manager'
        order.cancelledBy = 'owner'
        order.cancelledByName = user.name
        order.cancelledAt = new Date()
        await order.save()
        executionResult = order.toObject()
        break
      }

      case 'create_category': {
        const { label, slug, icon, description } = action.payload
        const createdCat = await Category.create({
          label,
          slug,
          icon: icon || 'Package',
          description: description || '',
        })
        executionResult = createdCat.toObject()
        break
      }

      case 'bulk_import_products': {
        const { products = [] } = action.payload
        const createdItems = []
        for (const p of products) {
          // Ensure category exists
          const catExists = await Category.findOne({ slug: p.categorySlug })
          if (!catExists && p.categorySlug) {
            await Category.create({
              label: p.categorySlug.replace(/-/g, ' ').toUpperCase(),
              slug: p.categorySlug,
              icon: 'Package',
            }).catch(() => null)
          }

          const savedPart = await Part.findOneAndUpdate(
            { slug: p.slug },
            {
              $set: {
                name: p.name,
                categorySlug: p.categorySlug,
                price: Number(p.price),
                stock: Number(p.stock) || 10,
                fits: p.fits || '',
                sku: p.sku || '',
                oemNumber: p.oemNumber || '',
                image: p.image || '',
                badge: p.badge || 'GENUINE',
                active: true,
              },
            },
            { upsert: true, new: true }
          )
          createdItems.push(savedPart.toObject())
        }
        executionResult = { importedCount: createdItems.length, items: createdItems }
        break
      }

      default:
        throw new Error(`Unsupported action type: ${action.actionType}`)
    }

    action.status = 'executed'
    action.approvedBy = user._id
    action.approvedByName = user.name
    action.approvedAt = new Date()
    action.executionResult = executionResult
    await action.save()

    // Write immutable audit log
    await AuditLog.create({
      actor: user._id,
      actorEmail: user.email,
      action: `ai_manager.${action.actionType}`,
      targetType: action.targetType,
      targetId: action.targetId,
      details: action.description || `Executed AI action ${action.title}`,
      aiGenerated: true,
      userConfirmed: true,
      beforeValue: action.previousState,
      afterValue: executionResult,
    })

    return { success: true, action: action.toObject(), executionResult }
  } catch (err) {
    action.status = 'failed'
    action.errorMessage = err.message
    await action.save()
    throw err
  }
}
