import mongoose from 'mongoose'

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true },
  plainCredentialEnc: { type: String, default: '' }, // Reversible AES-256 encrypted string for Store Owner audit view
  phone: { type: String, default: '' },
  avatar: { type: String, default: '' }, // profile image URL; UI falls back to initials
  address: { type: String, default: '' },
  city: { type: String, default: '' },
  primaryVehicle: { type: String, default: '' },
  vehicles: [
    {
      year: { type: String, default: '' },
      make: { type: String, default: '' },
      model: { type: String, default: '' },
      engine: { type: String, default: '' },
      vin: { type: String, default: '' },
      isPrimary: { type: Boolean, default: false },
    }
  ],
  isGoogleAuth: { type: Boolean, default: false },
  hasCustomPassword: { type: Boolean, default: true },
  privacyPreferences: {
    emailUpdates: { type: Boolean, default: true },
    whatsappAlerts: { type: Boolean, default: true },
    personalizedRecommendations: { type: Boolean, default: true },
  },
  role: { type: String, enum: ['user', 'admin', 'owner'], default: 'user' },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  isPrimaryOwner: { type: Boolean, default: false },
  resetPasswordToken: { type: String, default: '' },
  resetPasswordOtp: { type: String, default: '' },
  resetPasswordExpires: { type: Date, default: null },
}, { timestamps: true })

export default mongoose.model('User', userSchema)
