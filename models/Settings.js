// Store-wide configuration. A single document (only one can exist) edited by the
// Store Owner from the dashboard — never by admins and never in code.
import mongoose from 'mongoose'

const settingsSchema = new mongoose.Schema({
  storeName: { type: String, default: 'AutoGenuine' },
  tagline: { type: String, default: 'OEM GENUINE PARTS' },
  supportEmail: { type: String, default: 'support@autogenuine.com' },
  supportPhone: { type: String, default: '+92 321 3498203' },
  whatsappNumber: { type: String, default: '+923213498203' },
  address: { type: String, default: '42 Main Boulevard, Gulberg III, Lahore, Pakistan' },
  currency: { type: String, default: 'PKR' },
  shippingFee: { type: Number, default: 0 },        // flat rate per order
  freeShippingOver: { type: Number, default: 0 },   // spend threshold for free shipping
  taxRate: { type: Number, default: 0 },            // percent, e.g. 5 = 5%
  announcement: { type: String, default: 'GENUINE OEM TOYOTA PARTS • NATIONWIDE EXPRESS DISPATCH' }, // banner text shown on the storefront
  autoPilot: {
    enabled: { type: Boolean, default: false },
    speedMode: { type: String, enum: ['realistic', 'fast'], default: 'realistic' },
    autoConfirmOrders: { type: Boolean, default: true },
    autoDispatchOrders: { type: Boolean, default: true },
    maxAutoOrderValue: { type: Number, default: 250000 },
    autoRestockAlertThreshold: { type: Number, default: 5 },
    aiAutoCustomerSupport: { type: Boolean, default: true },
    dailyDigestSummary: { type: Boolean, default: true },
    awayModeEnabled: { type: Boolean, default: false },
    awayModeHours: { type: Number, default: 24 },
    minPendingThreshold: { type: Number, default: 10 },
    lastRunAt: { type: Date },
    logs: [
      {
        action: { type: String },
        details: { type: String },
        timestamp: { type: Date, default: Date.now },
      },
    ],
  },
  activePromoCampaign: {
    enabled: { type: Boolean, default: false },
    discountPercent: { type: Number, default: 0 },
    targetScope: { type: String, default: 'all' },
    bannerText: { type: String, default: '' },
    startedAt: { type: Date },
  },
}, { timestamps: true })

const Settings = mongoose.model('Settings', settingsSchema)

// Guarantee exactly one document exists (idempotent get-or-create).
export async function getSettingsDoc() {
  const existing = await Settings.findOne()
  if (existing) {
    // Ensure whatsappNumber has default if missing
    if (!existing.whatsappNumber) {
      existing.whatsappNumber = '+923213498203'
      await existing.save()
    }
    return existing
  }
  return Settings.create({
    whatsappNumber: '+923213498203',
  })
}

export default Settings
