import mongoose from 'mongoose'
import dns from "dns";

dns.setServers(["8.8.8.8", "8.8.4.4"]);
export async function connectDB(uri) {
  try {
    await mongoose.connect(uri)
    console.log('✓ MongoDB connected')
  } catch (err) {
    console.error('✗ MongoDB connection error:', err.message)
    process.exit(1)
  }
}
