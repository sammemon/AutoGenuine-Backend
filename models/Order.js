import mongoose from 'mongoose'

const orderItemSchema = new mongoose.Schema({
  partSlug: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  qty: { type: Number, required: true, min: 1 },
}, { _id: false })

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  items: { type: [orderItemSchema], required: true },
  total: { type: Number, required: true },
  status: {
    type: String,
    enum: ['pending', 'processing', 'packed', 'dispatched', 'out_for_delivery', 'shipped', 'delivered', 'cancelled'],
    default: 'pending',
  },
  paymentMethod: {
    type: String,
    enum: ['stripe', 'card', 'bank_transfer', 'paystack', 'wallet', 'easypaisa', 'jazzcash', 'whatsapp', 'cash', 'cod'],
    default: 'stripe',
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded', 'cancelled'],
    default: 'pending',
  },
  transactionReference: { type: String, default: '' },
  stripeSessionId: { type: String, default: '', index: true },
  stripePaymentIntentId: { type: String, default: '', index: true },
  paidAt: { type: Date },
  shippingAddress: { type: String, default: '' },
  city: { type: String, default: '' },
  customerName: { type: String, default: '' },
  customerPhone: { type: String, default: '' },
  customerEmail: { type: String, default: '' },
  notes: { type: String, default: '' },
  vehicleInfo: { type: String, default: '' },
  cancellationReason: { type: String, default: '' },
  cancelledBy: {
    type: String,
    enum: ['user', 'customer', 'admin', 'owner', 'system', ''],
    default: '',
  },
  cancelledByName: { type: String, default: '' },
  cancelledAt: { type: Date },
  approvedBy: {
    type: String,
    enum: ['admin', 'owner', 'system', ''],
    default: '',
  },
  approvedByName: { type: String, default: '' },
  approvedAt: { type: Date },
  refundId: { type: String, default: '' },
  refundAmount: { type: Number, default: 0 },
  refundedAt: { type: Date },
  refundReason: { type: String, default: '' },
  refundError: { type: String, default: '' },
}, { timestamps: true })

export default mongoose.model('Order', orderSchema)
