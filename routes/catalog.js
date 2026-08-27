import express from 'express'
import { listParts, getPart, listCategories, listVehicles, getStoreSettings } from '../controllers/catalogController.js'

const router = express.Router()

router.get('/parts', listParts)
router.get('/parts/:slug', getPart)
router.get('/categories', listCategories)
router.get('/vehicles', listVehicles)
router.get('/settings', getStoreSettings)

export default router
