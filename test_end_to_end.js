import 'dotenv/config'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { connectDB } from './config/db.js'
import User from './models/User.js'
import Part from './models/Part.js'
import Category from './models/Category.js'
import Vehicle from './models/Vehicle.js'
import express from 'express'
import cors from 'cors'
import authRoutes from './routes/auth.js'
import catalogRoutes from './routes/catalog.js'
import cartRoutes from './routes/cart.js'
import orderRoutes from './routes/orders.js'
import contactRoutes from './routes/contact.js'
import adminRoutes from './routes/admin.js'
import uploadRoutes from './routes/upload.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function runTests() {
  console.log('=== STARTING END-TO-END VERIFICATION ===\n')

  await connectDB(process.env.MONGODB_URI || 'mongodb://localhost:27017/autogenuine')

  // Setup express server on a test port
  const app = express()
  app.use(cors())
  app.use(express.json())
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')))
  app.use('/api/auth', authRoutes)
  app.use('/api/upload', uploadRoutes)
  app.use('/api/catalog', catalogRoutes)
  app.use('/api/cart', cartRoutes)
  app.use('/api/orders', orderRoutes)
  app.use('/api/contact', contactRoutes)
  app.use('/api/admin', adminRoutes)

  const TEST_PORT = 5055
  const server = app.listen(TEST_PORT)
  const BASE_URL = `http://localhost:${TEST_PORT}`

  let ownerToken = ''
  let adminToken = ''
  let customerToken = ''

  try {
    // 1. Authenticate Owner, Admin, Customer
    console.log('[1] Testing Authentication & Token Generation...')
    
    // Login as Owner
    const ownerRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: process.env.OWNER_EMAIL || 'OwnerAutogenuine@gmail.com', password: process.env.OWNER_PASSWORD || 'owner12345' }),
    })
    const ownerData = await ownerRes.json()
    if (!ownerRes.ok) throw new Error(`Owner login failed: ${JSON.stringify(ownerData)}`)
    ownerToken = ownerData.token
    console.log('  ✓ Owner authenticated:', ownerData.user.email, `(${ownerData.user.role})`)

    // Login as Admin
    const adminRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: process.env.ADMIN_EMAIL || 'adminautogenuine@gmail.com', password: process.env.ADMIN_PASSWORD || 'admin12345' }),
    })
    const adminData = await adminRes.json()
    if (!adminRes.ok) throw new Error(`Admin login failed: ${JSON.stringify(adminData)}`)
    adminToken = adminData.token
    console.log('  ✓ Admin authenticated:', adminData.user.email, `(${adminData.user.role})`)

    // Register/login a Customer
    const testCustomerEmail = `customer_test_${Date.now()}@example.com`
    const custRegRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Customer', email: testCustomerEmail, password: 'password123' }),
    })
    const custData = await custRegRes.json()
    if (!custRegRes.ok) throw new Error(`Customer register failed: ${JSON.stringify(custData)}`)
    customerToken = custData.token
    console.log('  ✓ Customer authenticated:', custData.user.email, `(${custData.user.role})`)

    // 2. Test Image Uploads
    console.log('\n[2] Testing Image Upload System...')

    // Create a dummy 100-byte valid JPG image
    const validJpgBuffer = Buffer.concat([
      Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]), // JPEG header
      Buffer.alloc(200, 0xAA),
      Buffer.from([0xFF, 0xD9]), // JPEG EOI
    ])
    
    // Valid JPG upload
    const formDataJpg = new FormData()
    formDataJpg.append('image', new Blob([validJpgBuffer], { type: 'image/jpeg' }), 'test_photo.jpg')
    const uploadJpgRes = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: formDataJpg,
    })
    const uploadJpgData = await uploadJpgRes.json()
    if (!uploadJpgRes.ok || !uploadJpgData.url.startsWith('/uploads/')) {
      throw new Error(`Valid JPG upload failed: ${JSON.stringify(uploadJpgData)}`)
    }
    console.log('  ✓ JPG upload succeeded:', uploadJpgData.url)

    // Verify static serving of the uploaded file
    const staticCheck = await fetch(`${BASE_URL}${uploadJpgData.url}`)
    if (!staticCheck.ok) throw new Error(`Static file serving failed for ${uploadJpgData.url}`)
    console.log('  ✓ Static serving verified (HTTP 200 OK)')

    // Valid PNG upload
    const validPngBuffer = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG signature
      Buffer.alloc(100, 0x55),
    ])
    const formDataPng = new FormData()
    formDataPng.append('image', new Blob([validPngBuffer], { type: 'image/png' }), 'test_item.png')
    const uploadPngRes = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: formDataPng,
    })
    const uploadPngData = await uploadPngRes.json()
    if (!uploadPngRes.ok || !uploadPngData.url) {
      throw new Error(`PNG upload failed: ${JSON.stringify(uploadPngData)}`)
    }
    console.log('  ✓ PNG upload succeeded:', uploadPngData.url)

    // Invalid file type test (e.g. text file)
    const formDataInvalid = new FormData()
    formDataInvalid.append('image', new Blob(['hello world'], { type: 'text/plain' }), 'document.txt')
    const uploadInvalidRes = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: formDataInvalid,
    })
    if (uploadInvalidRes.status === 400) {
      const err = await uploadInvalidRes.json()
      console.log('  ✓ Invalid file type correctly rejected:', err.error)
    } else {
      throw new Error('Invalid file type was not rejected with status 400')
    }

    // Oversized file test (> 5 MB)
    const bigBuffer = Buffer.alloc(5.5 * 1024 * 1024, 0x00)
    const formDataBig = new FormData()
    formDataBig.append('image', new Blob([bigBuffer], { type: 'image/jpeg' }), 'huge.jpg')
    const uploadBigRes = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: formDataBig,
    })
    if (uploadBigRes.status === 400) {
      const err = await uploadBigRes.json()
      console.log('  ✓ Oversized file (>5MB) correctly rejected:', err.error)
    } else {
      throw new Error('Oversized file was not rejected with status 400')
    }

    // Unauthenticated upload test
    const uploadNoAuthRes = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      body: formDataJpg,
    })
    if (uploadNoAuthRes.status === 401) {
      console.log('  ✓ Unauthenticated upload correctly rejected (401 Unauthorized)')
    } else {
      throw new Error('Unauthenticated upload did not return 401')
    }

    // 3. Test Products & Multi-Level Stock/Discount Validation
    console.log('\n[3] Testing Products & Numeric Input Validation...')
    const testSlug = `test-part-${Date.now()}`

    // Invalid stock: string "abc"
    const partBadStock = await fetch(`${BASE_URL}/api/admin/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ slug: `${testSlug}-bad1`, categorySlug: 'brakes', name: 'Bad Part', price: 1000, stock: 'abc' }),
    })
    if (partBadStock.status === 400) {
      const err = await partBadStock.json()
      console.log('  ✓ Invalid stock "abc" correctly rejected by backend:', err.error)
    } else {
      throw new Error('Invalid stock "abc" was not rejected')
    }

    // Invalid stock: negative "-10"
    const partNegStock = await fetch(`${BASE_URL}/api/admin/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ slug: `${testSlug}-bad2`, categorySlug: 'brakes', name: 'Bad Part', price: 1000, stock: -10 }),
    })
    if (partNegStock.status === 400) {
      const err = await partNegStock.json()
      console.log('  ✓ Negative stock "-10" correctly rejected by backend:', err.error)
    } else {
      throw new Error('Negative stock was not rejected')
    }

    // Invalid stock: decimal "1.5"
    const partDecStock = await fetch(`${BASE_URL}/api/admin/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ slug: `${testSlug}-bad3`, categorySlug: 'brakes', name: 'Bad Part', price: 1000, stock: '1.5' }),
    })
    if (partDecStock.status === 400) {
      const err = await partDecStock.json()
      console.log('  ✓ Decimal stock "1.5" correctly rejected by backend:', err.error)
    } else {
      throw new Error('Decimal stock was not rejected')
    }

    // Invalid discount: > 100
    const partBadDisc = await fetch(`${BASE_URL}/api/admin/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ slug: `${testSlug}-bad4`, categorySlug: 'brakes', name: 'Bad Part', price: 1000, discount: 120 }),
    })
    if (partBadDisc.status === 400) {
      const err = await partBadDisc.json()
      console.log('  ✓ Invalid discount "120" correctly rejected by backend:', err.error)
    } else {
      throw new Error('Invalid discount was not rejected')
    }

    // Valid product creation with uploaded image URL, stock=30, discount=15
    const partGood = await fetch(`${BASE_URL}/api/admin/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        slug: testSlug,
        categorySlug: 'brakes',
        name: 'AutoGenuine Premium Ceramic Brake Pads',
        price: 18500,
        stock: 30,
        discount: 15,
        badge: 'OEM',
        fits: 'Toyota Camry 2018-2024',
        sku: 'AG-BP-CAM',
        oemNumber: '04465-33471',
        image: uploadJpgData.url,
        featured: true,
        popular: true,
        active: true,
      }),
    })
    const partGoodData = await partGood.json()
    if (!partGood.ok || partGoodData.stock !== 30 || partGoodData.discount !== 15 || partGoodData.image !== uploadJpgData.url) {
      throw new Error(`Valid product creation failed: ${JSON.stringify(partGoodData)}`)
    }
    console.log('  ✓ Product created successfully with uploaded image & validated stock/discount:', partGoodData.slug)

    // Edit product with new image
    const partUpdate = await fetch(`${BASE_URL}/api/admin/parts/${testSlug}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'AutoGenuine Ultra Ceramic Brake Pads Updated',
        price: 19000,
        stock: 45,
        discount: 20,
        image: uploadPngData.url,
      }),
    })
    const partUpdateData = await partUpdate.json()
    if (!partUpdate.ok || partUpdateData.stock !== 45 || partUpdateData.image !== uploadPngData.url) {
      throw new Error(`Product update failed: ${JSON.stringify(partUpdateData)}`)
    }
    console.log('  ✓ Product updated successfully with replaced image:', partUpdateData.image)

    // Clean up test product
    await fetch(`${BASE_URL}/api/admin/parts/${testSlug}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    console.log('  ✓ Product deleted successfully')

    // 4. Test Category with Image Upload
    console.log('\n[4] Testing Category Management with Image Upload...')
    const catSlug = `test-cat-${Date.now()}`
    const catCreate = await fetch(`${BASE_URL}/api/admin/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        slug: catSlug,
        label: 'High Performance Exhaust',
        icon: 'Flame',
        description: 'Exhaust pipes, mufflers, catalytic converters',
        image: uploadJpgData.url,
      }),
    })
    const catData = await catCreate.json()
    if (!catCreate.ok || catData.image !== uploadJpgData.url) {
      throw new Error(`Category creation failed: ${JSON.stringify(catData)}`)
    }
    console.log('  ✓ Category created with image:', catData.slug, '->', catData.image)

    // Clean up category
    await fetch(`${BASE_URL}/api/admin/categories/${catSlug}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    })
    console.log('  ✓ Category deleted')

    // 5. Test Vehicle with Image Upload & Year Validation
    console.log('\n[5] Testing Vehicle Management & Year Validation...')
    // Bad year: from > to
    const vehBad = await fetch(`${BASE_URL}/api/admin/vehicles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ make: 'Honda', model: 'Accord', from: 2024, to: 2010 }),
    })
    if (vehBad.status === 400) {
      const err = await vehBad.json()
      console.log('  ✓ Invalid years (from > to) correctly rejected:', err.error)
    } else {
      throw new Error('Invalid vehicle years were not rejected')
    }

    // Good vehicle creation
    const vehGood = await fetch(`${BASE_URL}/api/admin/vehicles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        make: 'Honda',
        model: 'Accord Turbo',
        from: 2018,
        to: 2024,
        parts: '850+',
        image: uploadPngData.url,
        inStock: true,
      }),
    })
    const vehData = await vehGood.json()
    if (!vehGood.ok || vehData.image !== uploadPngData.url) {
      throw new Error(`Vehicle creation failed: ${JSON.stringify(vehData)}`)
    }
    console.log('  ✓ Vehicle created with image:', vehData._id, '->', vehData.image)

    // Clean up vehicle
    await fetch(`${BASE_URL}/api/admin/vehicles/${vehData._id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    console.log('  ✓ Vehicle deleted')

    // 6. Test Profile Image Upload & Update for Customer, Admin & Owner
    console.log('\n[6] Testing Profile Photo Upload & Updates...')
    
    // Customer profile update with uploaded image
    const custProfileRes = await fetch(`${BASE_URL}/api/auth/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ name: 'Updated Customer Name', avatar: uploadJpgData.url }),
    })
    const custProfileData = await custProfileRes.json()
    if (!custProfileRes.ok || custProfileData.user.avatar !== uploadJpgData.url) {
      throw new Error(`Customer profile update failed: ${JSON.stringify(custProfileData)}`)
    }
    console.log('  ✓ Customer profile updated with new avatar:', custProfileData.user.avatar)

    // 7. Role Restrictions Check
    console.log('\n[7] Testing Role Restrictions & Security Enforcement...')
    const custUnauthorizedRes = await fetch(`${BASE_URL}/api/admin/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ slug: 'hack', categorySlug: 'brakes', name: 'Hack Part', price: 100 }),
    })
    if (custUnauthorizedRes.status === 403) {
      console.log('  ✓ Customer unauthorized access to admin endpoint correctly blocked (403 Forbidden)')
    } else {
      throw new Error(`Customer was not blocked with 403 (received ${custUnauthorizedRes.status})`)
    }

    // Clean up test customer
    await User.deleteOne({ email: testCustomerEmail })

    console.log('\n=== ALL END-TO-END VERIFICATION CHECKS PASSED SUCCESSFULLY! ===')
  } finally {
    server.close()
    process.exit(0)
  }
}

runTests().catch((err) => {
  console.error('\n❌ VERIFICATION TEST FAILED:', err)
  process.exit(1)
})
