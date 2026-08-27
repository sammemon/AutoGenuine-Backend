import 'dotenv/config'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import { connectDB } from './config/db.js'
import Category from './models/Category.js'
import Part from './models/Part.js'
import Vehicle from './models/Vehicle.js'
import User from './models/User.js'

// Icon name strings, resolved on the client
const categoryData = [
  { slug: 'brakes', label: 'Brakes', icon: 'Disc', description: 'Brake pads, rotors, calipers and brake fluid — everything to stop safely, every time.', image: '/images/categories/brakes.jpg' },
  { slug: 'engine', label: 'Engine', icon: 'Settings', description: 'Spark plugs, belts, gaskets and engine mounts to keep your engine running smooth.', image: '/images/categories/engine.jpg' },
  { slug: 'suspension', label: 'Suspension & Steering', icon: 'Wrench', description: 'Shock absorbers, control arms and steering components for a smooth, controlled ride.', image: '/images/categories/suspension.jpg' },
  { slug: 'filters', label: 'Filters', icon: 'Filter', description: 'Oil, air, cabin and fuel filters — genuine filtration built to OEM spec.', image: '/images/categories/filters.jpg' },
  { slug: 'electrical', label: 'Electrical', icon: 'Zap', description: 'Batteries, alternators, starters and wiring — keep every system powered.', image: 'https://images.unsplash.com/photo-1593941707882-a5bba14938c7?auto=format&fit=crop&w=900&q=80' },
  { slug: 'body', label: 'Body & Exterior', icon: 'ShieldHalf', description: 'Bumpers, mirrors, headlights and trim to keep your Toyota looking factory-fresh.', image: 'https://images.unsplash.com/photo-1618843479313-40f8afb4b4d8?auto=format&fit=crop&w=900&q=80' },
]

const partsData = [
  { slug: 'brake-pad-camry', categorySlug: 'brakes', badge: 'OEM', name: 'Front Brake Pad Set (Ceramic)', fits: 'Fits: Toyota Camry 2015 – 2020', price: 18500, image: '/images/categories/Front-Brake.jpg', stock: 45 },
  { slug: 'brake-rotor-corolla', categorySlug: 'brakes', badge: 'GENUINE', name: 'Front Brake Rotor (Vented)', fits: 'Fits: Toyota Corolla 2014 – 2023', price: 22300, image: '/images/categories/Front-Brake-Rotor.jpg', stock: 32 },
  { slug: 'oil-filter-corolla', categorySlug: 'filters', badge: 'GENUINE', name: 'Genuine Oil Filter', fits: 'Fits: Toyota Corolla 2014 – 2023', price: 4200, image: '/images/categories/Genuine-Oil-Filter.jpg', stock: 150 },
  { slug: 'air-filter-camry', categorySlug: 'filters', badge: 'OEM', name: 'Engine Air Filter', fits: 'Fits: Toyota Camry 2012 – 2021', price: 6800, image: '/images/categories/engine-air-filter.jpg', stock: 120 },
  { slug: 'shock-hilux', categorySlug: 'suspension', badge: 'OEM', name: 'Front Shock Absorber', fits: 'Fits: Toyota Hilux 2016 – 2022', price: 42900, image: '/images/categories/Front-Shock.jpg', stock: 28 },
  { slug: 'control-arm-hilux', categorySlug: 'suspension', badge: 'GENUINE', name: 'Lower Control Arm', fits: 'Fits: Toyota Hilux 2011 – 2015', price: 31500, image: '/images/categories/Lower-Control-Arm.jpg', stock: 22 },
  { slug: 'alternator-camry', categorySlug: 'electrical', badge: 'GENUINE', name: 'Alternator Assembly 12V', fits: 'Fits: Toyota Camry 2012 – 2018', price: 86000, image: '/images/categories/Alternator-Assembly-12V.jpg', stock: 15 },
  { slug: 'battery-corolla', categorySlug: 'electrical', badge: 'OEM', name: 'Maintenance-Free Car Battery', fits: 'Fits: Toyota Corolla 2009 – 2019', price: 54000, image: '/images/categories/Maintenance-Free-Car-Battery.jpg', stock: 60 },
  { slug: 'spark-plug-camry', categorySlug: 'engine', badge: 'GENUINE', name: 'Iridium Spark Plug (Set of 4)', fits: 'Fits: Toyota Camry 2007 – 2017', price: 15200, image: '/images/categories/Iridium-Spark-Plug.jpg', stock: 80 },
  { slug: 'timing-belt-hilux', categorySlug: 'engine', badge: 'OEM', name: 'Timing Belt Kit', fits: 'Fits: Toyota Hilux 2011 – 2018', price: 28700, image: '/images/categories/Timing-Belt-Kit.jpg', stock: 40 },
  { slug: 'headlight-camry', categorySlug: 'body', badge: 'OEM', name: 'Headlight Assembly (Right)', fits: 'Fits: Toyota Camry 2015 – 2017', price: 63500, image: '/images/categories/Headlight-Assembly.jpg', stock: 18 },
  { slug: 'bumper-corolla', categorySlug: 'body', badge: 'GENUINE', name: 'Front Bumper Cover', fits: 'Fits: Toyota Corolla 2017 – 2019', price: 74000, image: '/images/categories/bumper-front.jpg', stock: 12 },
]

const vehicleData = [
  { make: 'Toyota', model: 'Camry', from: 2007, to: 2024, parts: '1,200+', image: 'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?auto=format&fit=crop&w=800&q=80', inStock: true },
  { make: 'Toyota', model: 'Corolla', from: 2009, to: 2024, parts: '1,050+', image: 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?auto=format&fit=crop&w=800&q=80', inStock: true },
  { make: 'Toyota', model: 'Hilux', from: 2011, to: 2024, parts: '980+', image: 'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&w=800&q=80', inStock: true },
  { make: 'Toyota', model: 'Highlander', from: 2010, to: 2024, parts: '640+', image: 'https://images.unsplash.com/photo-1519641471654-76ce0107ad1b?auto=format&fit=crop&w=800&q=80', inStock: true },
  { make: 'Toyota', model: 'RAV4', from: 2013, to: 2024, parts: '710+', image: 'https://images.unsplash.com/photo-1609521263047-f8f205293f24?auto=format&fit=crop&w=800&q=80', inStock: true },
]

async function seed() {
  await connectDB(process.env.MONGODB_URI || 'mongodb://localhost:27017/autogenuine')

  console.log('Clearing existing data...')
  await Category.deleteMany({})
  await Part.deleteMany({})
  await Vehicle.deleteMany({})

  console.log('Seeding categories...')
  await Category.insertMany(categoryData)

  console.log('Seeding parts...')
  await Part.insertMany(partsData)

  console.log('Seeding vehicles...')
  await Vehicle.insertMany(vehicleData)

  // Ensure a staff account exists at the given role (idempotent — keyed by email).
  // Existing accounts are lifted to the role; a matching *_PASSWORD env var resets the password.
  async function ensureStaffUser({ email, password, name, role, passwordFromEnv, primary = false }) {
    const lowerEmail = email.toLowerCase()
    const existing = await User.findOne({ email: lowerEmail })
    if (existing) {
      existing.role = role
      if (primary) existing.isPrimaryOwner = true
      if (passwordFromEnv) existing.passwordHash = await bcrypt.hash(password, 10)
      await existing.save()
      console.log(`${role} already existed — ensured role=${role}${primary ? ' (primary owner)' : ''} (${lowerEmail})`)
      return
    }
    const passwordHash = await bcrypt.hash(password, 10)
    await User.create({ name, email: lowerEmail, passwordHash, role, isPrimaryOwner: primary })
    console.log(`Created ${role} account${primary ? ' (primary owner)' : ''}:`)
    console.log(`  email:    ${lowerEmail}`)
    console.log(`  password: ${password}`)
    console.log('  ^ change this password after first login (or set the *_PASSWORD env var)')
  }

  // Owner — top role, full control including managing admins. Flagged primary:
  // the root account that no one else can demote, suspend or delete.
  await ensureStaffUser({
    name: process.env.OWNER_NAME || 'Store Owner',
    email: process.env.OWNER_EMAIL || 'owner@example.com',
    password: process.env.OWNER_PASSWORD || 'owner12345',
    role: 'owner',
    passwordFromEnv: !!process.env.OWNER_PASSWORD,
    primary: true,
  })

  // Admin — manages catalog and orders; cannot manage other staff.
  await ensureStaffUser({
    name: process.env.ADMIN_NAME || 'Store Admin',
    email: process.env.ADMIN_EMAIL || 'admin@example.com',
    password: process.env.ADMIN_PASSWORD || 'admin12345',
    role: 'admin',
    passwordFromEnv: !!process.env.ADMIN_PASSWORD,
  })

  console.log('✓ Seed complete')
  process.exit(0)
}

seed().catch((err) => {
  console.error('Seed error:', err)
  process.exit(1)
})
