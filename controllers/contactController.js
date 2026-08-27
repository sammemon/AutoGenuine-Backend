import ContactMessage from '../models/ContactMessage.js'
import { createNotification } from '../services/notificationService.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function submitContact(req, res) {
  const { name, email, phone, subject, message } = req.body || {}

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required' })
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' })
  }
  if (message.length < 10) {
    return res.status(400).json({ error: 'Message is too short (min 10 characters)' })
  }

  const contactDoc = await ContactMessage.create({ name, email, phone: phone || '', subject: subject || '', message })

  // Trigger Notification Service (Socket if staff online, Email if offline)
  createNotification({
    type: 'NEW_CONTACT_MESSAGE',
    title: `✉️ New Contact Message: ${subject || 'General Inquiry'}`,
    message: `Contact message from ${name} (${email}): ${message.substring(0, 80)}...`,
    recipientRole: 'staff',
    customerName: name,
    customerEmail: email,
    metadata: {
      contactId: contactDoc._id,
      name,
      email,
      phone: phone || '',
      subject: subject || 'General Inquiry',
      message,
    },
  })

  res.status(201).json({ message: 'Thanks! Your message has been received.' })
}
