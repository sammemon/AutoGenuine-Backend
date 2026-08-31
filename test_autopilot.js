import mongoose from 'mongoose'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { runAutoPilotCycle } from './services/autoPilotService.js'
import { getSettingsDoc } from './models/Settings.js'
import { executeStoreTool, executeApprovedStoreAction } from './services/aiStoreManagerService.js'
import Part from './models/Part.js'
import User from './models/User.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config({ path: path.join(__dirname, '.env') })

async function runTests() {
  console.log('--- Testing Auto-Pilot & Bulk Spreadsheet Ingestion ---')
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/autogenuine')

  const owner = await User.findOne({ role: 'owner' }) || { _id: new mongoose.Types.ObjectId(), name: 'Test Owner', role: 'owner' }

  // 1. Test Bulk Spreadsheet Import Tool
  console.log('\n[Test 1] Testing propose_bulk_import_products tool...')
  const sampleProducts = [
    {
      name: 'Corolla 2024 OEM Front Strut Assembly',
      categorySlug: 'suspension',
      price: 28500,
      stock: 12,
      fits: 'Toyota Corolla 2020-2025',
      oemNumber: '48510-02W10',
      sku: 'TOY-SUSP-01',
    },
    {
      name: 'Civic RS Turbo Performance Intercooler Hose',
      categorySlug: 'engine',
      price: 18000,
      stock: 6,
      fits: 'Honda Civic RS 2022-2025',
      oemNumber: '17228-5AA-A00',
      sku: 'HON-ENG-02',
    },
  ]

  const toolRes = await executeStoreTool('propose_bulk_import_products', {
    products: sampleProducts,
    sourceFileName: 'supplier_catalog_august.csv',
  }, owner)

  console.log('Bulk tool result:', toolRes)
  if (!toolRes.proposalCreated || !toolRes.actionId) {
    throw new Error('Failed to create bulk import proposal')
  }

  // Execute the proposal
  console.log('\n[Test 2] Testing executeApprovedStoreAction for bulk import...')
  const execRes = await executeApprovedStoreAction(toolRes.actionId, owner)
  console.log('Execution result:', execRes.success, 'Items imported:', execRes.result?.importedCount)

  const verifyPart = await Part.findOne({ sku: 'TOY-SUSP-01' })
  if (!verifyPart) throw new Error('Imported part not found in MongoDB!')
  console.log('✓ Successfully verified imported part in MongoDB:', verifyPart.name, 'Price:', verifyPart.price)

  // 3. Test AutoPilot Cycle
  console.log('\n[Test 3] Testing Autonomous Auto-Pilot Cycle...')
  const settings = await getSettingsDoc()
  settings.autoPilot.enabled = true
  settings.autoPilot.autoConfirmOrders = true
  await settings.save()

  const autoRes = await runAutoPilotCycle()
  console.log('AutoPilot cycle result:', autoRes)

  console.log('\n✓ ALL AUTONOMOUS & BULK IMPORT TESTS PASSED!')
  await mongoose.disconnect()
  process.exit(0)
}

runTests().catch((err) => {
  console.error('Test failed:', err)
  process.exit(1)
})
