import nodemailer from 'nodemailer'

let transporter = null
let isTransporterVerified = false

/**
 * Creates and returns the Nodemailer transporter instance (singleton/lazy).
 * If SMTP environment variables are missing, returns null so operations degrade gracefully.
 */
export function getTransporter() {
  if (transporter) return transporter

  const host = process.env.SMTP_HOST || 'smtp.gmail.com'
  const user = (process.env.SMTP_USER || 'sm275665@gmail.com').trim()
  const pass = (process.env.SMTP_PASS || 'jcef kbev socn qavm').replace(/^["']|["']$/g, '').trim()
  const port = parseInt(process.env.SMTP_PORT || '587', 10)
  const secure = process.env.SMTP_SECURE !== undefined ? process.env.SMTP_SECURE === 'true' : port === 465

  if (!host || !user || !pass) {
    // Graceful fallback when SMTP credentials are not yet set
    return null
  }

  try {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      host,
      port,
      secure,
      auth: { user, pass },
      connectionTimeout: 4000,
      greetingTimeout: 4000,
      socketTimeout: 6000,
      tls: {
        rejectUnauthorized: false,
      },
    })
    return transporter
  } catch (err) {
    console.error('❌ [emailService] Transporter creation failed:', err.message)
    return null
  }
}

/**
 * Verifies SMTP connection if transporter is configured.
 */
export async function verifySmtpConnection() {
  const transport = getTransporter()
  if (!transport) {
    console.log('ℹ️ [emailService] SMTP not fully configured (set SMTP_USER & SMTP_PASS in .env to enable emails)')
    return false
  }

  if (isTransporterVerified) return true

  try {
    await transport.verify()
    isTransporterVerified = true
    console.log('⚡ [emailService] SMTP Server Connection Verified Successfully!')
    return true
  } catch (err) {
    console.error('❌ [emailService] SMTP Verification Warning:', err.message)
    return false
  }
}

/**
 * Sends an email using Gmail HTTPS Relay or Nodemailer SMTP.
 * Never throws an error that crashes the calling business logic.
 */
export async function sendEmail({ to, subject, html, text }) {
  try {
    if (!to) {
      return { success: false, reason: 'No recipient email specified' }
    }

    // Remap legacy dummy email targets to actual staff mailbox addresses
    let recipientTo = to
    const remapEmail = (addr) => {
      if (!addr) return addr
      const lower = String(addr).toLowerCase().trim()
      if (lower === 'owner@autogenuine.com' || lower === 'owner@example.com') {
        return process.env.OWNER_EMAIL || 'OwnerAutogenuine@gmail.com'
      }
      if (lower === 'admin@autogenuine.com' || lower === 'admin@example.com') {
        return process.env.ADMIN_EMAIL || 'adminautogenuine@gmail.com'
      }
      return addr
    }

    if (typeof recipientTo === 'string') {
      recipientTo = remapEmail(recipientTo)
    } else if (Array.isArray(recipientTo)) {
      recipientTo = recipientTo.map(remapEmail)
    }

    const recipients = Array.isArray(recipientTo) ? recipientTo : [recipientTo]

    const relayUrl = process.env.GMAIL_RELAY_URL || process.env.GMAIL_HTTP_URL || ''
    if (relayUrl) {
      try {
        const res = await fetch(relayUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          redirect: 'follow',
          body: JSON.stringify({
            to: recipients,
            subject,
            html,
            text: text || subject,
            from: process.env.SMTP_USER || process.env.OWNER_EMAIL || '',
          }),
        })
        const textResp = await res.text()
        let data = {}
        try { data = JSON.parse(textResp) } catch { data = {} }

        if (res.ok && (data.status === 'success' || !data.status)) {
          console.log(`✉️ [emailService] (Gmail HTTPS Relay) Email sent successfully to ${recipients.join(', ')}`)
          return { success: true, messageId: `gmail_relay_${Date.now()}` }
        }
        console.warn(`⚠️ [emailService] Gmail HTTPS Relay notice: ${textResp}`)
      } catch (relayErr) {
        console.warn('⚠️ [emailService] Gmail HTTPS Relay notice:', relayErr.message)
      }
    }

    // 2. Nodemailer Gmail SMTP Engine
    const transport = getTransporter()
    if (!transport) {
      console.log(`ℹ️ [emailService] Email dispatch skipped (SMTP credentials missing). Target: ${recipients.join(', ')} | Subject: "${subject}"`)
      return { success: false, reason: 'SMTP credentials missing' }
    }

    const from = process.env.EMAIL_FROM || '"AutoGenuine Parts" <sm275665@gmail.com>'
    const replyTo = process.env.SMTP_USER || 'sm275665@gmail.com'

    const mailOptions = {
      from,
      replyTo,
      to: recipients.length === 1 ? recipients[0] : recipients,
      subject,
      text: text || subject,
      html,
      headers: {
        'X-Priority': '1',
        'X-MSMail-Priority': 'High',
        'Importance': 'high',
        'X-Mailer': 'AutoGenuine Transactional Engine v1.0',
        'X-Auto-Response-Suppress': 'OOF, AutoReply',
      },
    }

    const info = await transport.sendMail(mailOptions)
    console.log(`✉️ [emailService] (Nodemailer SMTP) Email sent successfully to ${recipients.join(', ')} (MessageId: ${info.messageId})`)

    return {
      success: true,
      messageId: info.messageId,
      accepted: info.accepted,
    }
  } catch (err) {
    if (err.message && err.message.includes('timeout')) {
      console.warn(`⚠️ [emailService] Nodemailer SMTP connection timed out (Railway firewall blocks TCP port ${process.env.SMTP_PORT || 587}). Set GMAIL_RELAY_URL in Railway Variables to enable Gmail HTTPS Relay.`)
    } else {
      console.error(`❌ [emailService] Failed to send email to ${to}:`, err.message)
    }
    return {
      success: false,
      error: err.message,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML Email Layout Wrapper & Templates
// ─────────────────────────────────────────────────────────────────────────────

function emailWrapper({ title, preheader = '', contentHtml, actionUrl = '', actionText = '' }) {
  const clientUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
  const targetUrl = actionUrl || `${clientUrl}/#/dashboard`

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #0f172a; }
    .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08); border: 1px solid #e2e8f0; }
    .header { background: #0f172a; padding: 24px 32px; text-align: left; }
    .header-logo { color: #f97316; font-size: 20px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase; margin: 0; display: inline-block; }
    .header-sub { color: #94a3b8; font-size: 12px; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .body { padding: 32px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge-brand { background: #fff7ed; color: #c2410c; border: 1px solid #ffedd5; }
    .badge-green { background: #f0fdf4; color: #15803d; border: 1px solid #dcfce7; }
    .badge-red { background: #fef2f2; color: #b91c1c; border: 1px solid #fee2e2; }
    .badge-amber { background: #fffbeb; color: #b45309; border: 1px solid #fef3c7; }
    .title { font-size: 20px; font-weight: 800; color: #0f172a; margin: 16px 0 8px 0; }
    .subtitle { font-size: 14px; color: #64748b; margin-bottom: 24px; }
    .info-card { background: #f8fafc; border-radius: 8px; padding: 16px; border: 1px solid #e2e8f0; margin-bottom: 24px; }
    .info-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; }
    .info-label { color: #64748b; font-weight: 600; }
    .info-value { color: #0f172a; font-weight: 700; text-align: right; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th { text-align: left; padding: 10px; background: #f1f5f9; font-size: 11px; font-weight: 800; text-transform: uppercase; color: #475569; }
    td { padding: 12px 10px; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
    .btn { display: inline-block; padding: 12px 24px; background: #ea580c; color: #ffffff !important; text-decoration: none; font-size: 13px; font-weight: 800; border-radius: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
    .btn-wrap { text-align: center; margin: 28px 0 12px 0; }
    .footer { background: #f8fafc; padding: 20px 32px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-logo">🚗 AutoGenuine</div>
      <div class="header-sub">Genuine OEM Auto Parts &amp; Store Management</div>
    </div>
    <div class="body">
      ${contentHtml}
      ${
        actionText
          ? `<div class="btn-wrap">
              <a href="${targetUrl}" class="btn" target="_blank">${actionText}</a>
            </div>`
          : ''
      }
    </div>
    <div class="footer">
      This is an automated system notification from AutoGenuine Parts Management Console.<br>
      © ${new Date().getFullYear()} AutoGenuine Inc. All rights reserved.
    </div>
  </div>
</body>
</html>`
}

/**
 * 1. New Order Email Template
 */
export function buildNewOrderEmail({ order, customerName, total, items = [], paymentMethod, orderRef }) {
  const ref = orderRef || order.orderRef || String(order._id || '').slice(-6).toUpperCase()
  const itemsTable = items
    .map(
      (i) => `<tr>
        <td><strong>${i.name}</strong><br><small style="color:#64748b;">Qty: ${i.qty}</small></td>
        <td style="text-align:right;">Rs ${(i.price * i.qty).toLocaleString()}</td>
      </tr>`
    )
    .join('')

  const html = `
    <span class="badge badge-brand">🛒 NEW ORDER PLACED</span>
    <h1 class="title">New Order #${ref} Received</h1>
    <p class="subtitle">A new order has been successfully created by <strong>${customerName || 'Customer'}</strong>.</p>

    <div class="info-card">
      <div class="info-row"><span class="info-label">Customer Name:</span><span class="info-value">${customerName || order?.customerName || 'N/A'}</span></div>
      <div class="info-row"><span class="info-label">Customer Email:</span><span class="info-value">${order?.customerEmail || 'N/A'}</span></div>
      <div class="info-row"><span class="info-label">Customer Phone:</span><span class="info-value">${order?.customerPhone || 'N/A'}</span></div>
      <div class="info-row"><span class="info-label">Payment Method:</span><span class="info-value">${(paymentMethod || order?.paymentMethod || 'Card').toUpperCase()}</span></div>
      <div class="info-row"><span class="info-label">City / Address:</span><span class="info-value">${order?.city || ''} ${order?.shippingAddress ? `(${order.shippingAddress})` : ''}</span></div>
      <div class="info-row"><span class="info-label">Total Amount:</span><span class="info-value" style="color:#ea580c; font-size:16px;">Rs ${Number(total || order?.total || 0).toLocaleString()}</span></div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Part Item</th>
          <th style="text-align:right;">Subtotal</th>
        </tr>
      </thead>
      <tbody>
        ${itemsTable}
      </tbody>
    </table>
  `

  return {
    subject: `🛒 New Order #${ref} — Rs ${Number(total || 0).toLocaleString()} (${customerName || 'Customer'})`,
    html: emailWrapper({
      title: `New Order #${ref}`,
      contentHtml: html,
      actionText: 'View Order in Dashboard',
      actionUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/dashboard/orders`,
    }),
  }
}

/**
 * Customer Thank You & Order Receipt Email Template
 */
export function buildCustomerOrderConfirmationEmail({ order, customerName, total, items = [], paymentMethod, orderRef }) {
  const ref = orderRef || order?.orderRef || String(order?._id || '').slice(-6).toUpperCase()
  const itemsTable = items
    .map(
      (i) => `<tr>
        <td><strong>${i.name}</strong><br><small style="color:#64748b;">Qty: ${i.qty}</small></td>
        <td style="text-align:right;">Rs ${(i.price * i.qty).toLocaleString()}</td>
      </tr>`
    )
    .join('')

  const html = `
    <span class="badge badge-green">🎉 THANK YOU FOR YOUR ORDER</span>
    <h1 class="title">Order #${ref} Confirmed!</h1>
    <p class="subtitle">Hi <strong>${customerName || 'Valued Customer'}</strong>, thank you for shopping with AutoGenuine! We have received your order and are preparing your OEM auto parts for dispatch.</p>

    <div class="info-card">
      <div class="info-row"><span class="info-label">Order Reference:</span><span class="info-value">#${ref}</span></div>
      <div class="info-row"><span class="info-label">Payment Method:</span><span class="info-value">${(paymentMethod || order?.paymentMethod || 'Cash on Delivery').toUpperCase()}</span></div>
      <div class="info-row"><span class="info-label">Delivery Address:</span><span class="info-value">${order?.city || ''} ${order?.shippingAddress ? `(${order.shippingAddress})` : ''}</span></div>
      <div class="info-row"><span class="info-label">Total Amount:</span><span class="info-value" style="color:#ea580c; font-size:16px;">Rs ${Number(total || order?.total || 0).toLocaleString()}</span></div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Part Description</th>
          <th style="text-align:right;">Subtotal</th>
        </tr>
      </thead>
      <tbody>
        ${itemsTable}
      </tbody>
    </table>
  `

  return {
    subject: `🎉 Order Confirmed! Thank you for ordering from AutoGenuine (#${ref})`,
    html: emailWrapper({
      title: `Order #${ref} Confirmed`,
      contentHtml: html,
      actionText: 'Track Your Live Order',
      actionUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/track?ref=${ref}`,
    }),
  }
}

/**
 * Abandoned Cart Recovery Email Template
 */
export function buildAbandonedCartEmail({ customerName, items = [], total = 0 }) {
  const calculatedTotal = total || items.reduce((sum, i) => sum + ((i.price || 0) * (i.qty || 1)), 0)
  const clientUrl = process.env.FRONTEND_URL || 'http://localhost:5173'

  const itemsTable = items
    .map(
      (i) => `<tr>
        <td style="padding:12px; border-bottom:1px solid #f1f5f9;">
          <strong style="color:#0f172a; font-size:14px;">${i.name || i.partSlug || 'OEM Auto Part'}</strong><br>
          <span style="color:#64748b; font-size:12px;">Quantity: <strong>${i.qty}</strong> &bull; Unit Price: Rs ${Number(i.price || 0).toLocaleString()}</span>
        </td>
        <td style="text-align:right; padding:12px; border-bottom:1px solid #f1f5f9; font-weight:800; color:#ea580c; font-size:14px;">
          Rs ${((i.price || 0) * (i.qty || 1)).toLocaleString()}
        </td>
      </tr>`
    )
    .join('')

  const html = `
    <span class="badge badge-brand">🛒 ITEMS WAITING IN YOUR CART</span>
    <h1 class="title">Complete Your AutoGenuine Order</h1>
    <p class="subtitle">Hi <strong>${customerName || 'Valued Customer'}</strong>, you left genuine OEM auto parts waiting in your AutoGenuine shopping cart!</p>

    <div class="info-card">
      <div class="info-row"><span class="info-label">Reserved Items:</span><span class="info-value">${items.length} OEM Parts</span></div>
      <div class="info-row"><span class="info-label">Estimated Cart Total:</span><span class="info-value" style="color:#ea580c; font-size:18px;">Rs ${Number(calculatedTotal).toLocaleString()}</span></div>
    </div>

    <table style="width:100%; border-collapse:collapse; margin-bottom:24px;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="text-align:left; padding:10px 12px; font-size:11px; font-weight:800; text-transform:uppercase; color:#475569;">Selected OEM Auto Part</th>
          <th style="text-align:right; padding:10px 12px; font-size:11px; font-weight:800; text-transform:uppercase; color:#475569;">Subtotal</th>
        </tr>
      </thead>
      <tbody>
        ${itemsTable}
      </tbody>
    </table>

    <div style="background:#fff7ed; border:1px solid #ffedd5; padding:16px; border-radius:8px; margin-bottom:24px;">
      <p style="margin:0; font-size:13px; color:#c2410c; line-height:1.5;">
        ⚡ <strong>Inventory Notice:</strong> Genuine OEM stock for these items is limited. Complete your checkout now to secure your parts and lock in fast dispatch.
      </p>
    </div>
  `

  return {
    subject: `🛒 You left items in your cart! Complete your AutoGenuine order now`,
    html: emailWrapper({
      title: 'Complete Your Cart Order',
      contentHtml: html,
      actionText: '🛒 Complete My Order at AutoGenuine',
      actionUrl: `${clientUrl}/#/cart`,
    }),
  }
}

/**
 * 2. New Support Message Email Template
 */
export function buildNewMessageEmail({ senderName, senderEmail, messageText, conversationId, orderRef }) {
  const html = `
    <span class="badge badge-amber">💬 NEW SUPPORT MESSAGE</span>
    <h1 class="title">Message from ${senderName || 'Customer'}</h1>
    <p class="subtitle">You have received a new support chat message requiring staff assistance.</p>

    <div class="info-card">
      <div class="info-row"><span class="info-label">Sender Name:</span><span class="info-value">${senderName || 'Customer'}</span></div>
      <div class="info-row"><span class="info-label">Sender Email:</span><span class="info-value">${senderEmail || 'N/A'}</span></div>
      ${orderRef ? `<div class="info-row"><span class="info-label">Related Order:</span><span class="info-value">#${orderRef}</span></div>` : ''}
    </div>

    <div style="background:#f1f5f9; border-left:4px solid #ea580c; padding:16px; border-radius:6px; font-size:14px; color:#0f172a; line-height:1.6; margin-bottom:24px;">
      "${messageText}"
    </div>
  `

  return {
    subject: `💬 New Message from ${senderName || 'Customer'}${orderRef ? ` (Order #${orderRef})` : ''}`,
    html: emailWrapper({
      title: 'New Support Message',
      contentHtml: html,
      actionText: 'Open Chat Workspace',
      actionUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/dashboard/messages`,
    }),
  }
}

/**
 * 3. New Contact Message Email Template
 */
export function buildContactMessageEmail({ name, email, phone, subject, message }) {
  const html = `
    <span class="badge badge-brand">✉️ NEW CONTACT INQUIRY</span>
    <h1 class="title">Contact Submission: ${subject || 'General Inquiry'}</h1>
    <p class="subtitle">A website visitor submitted a new contact form message.</p>

    <div class="info-card">
      <div class="info-row"><span class="info-label">Name:</span><span class="info-value">${name || 'N/A'}</span></div>
      <div class="info-row"><span class="info-label">Email:</span><span class="info-value">${email || 'N/A'}</span></div>
      <div class="info-row"><span class="info-label">Phone:</span><span class="info-value">${phone || 'N/A'}</span></div>
      <div class="info-row"><span class="info-label">Subject:</span><span class="info-value">${subject || 'General Inquiry'}</span></div>
    </div>

    <div style="background:#f8fafc; border:1px solid #cbd5e1; padding:16px; border-radius:8px; font-size:14px; color:#0f172a; line-height:1.6;">
      ${message}
    </div>
  `

  return {
    subject: `✉️ New Contact Inquiry: ${subject || 'General Inquiry'} (${name})`,
    html: emailWrapper({
      title: 'New Contact Submission',
      contentHtml: html,
      actionText: 'View Inquiries in Dashboard',
      actionUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/dashboard/messages?tab=inquiries`,
    }),
  }
}

/**
 * 4. AI Escalation Email Template
 */
export function buildAIEscalationEmail({ customerName, customerEmail, reason, priority = 'high', category = 'general_support', aiSummary, recommendedAction, orderRef }) {
  const html = `
    <span class="badge badge-red">🚨 AI SUPPORT ESCALATION (${priority.toUpperCase()})</span>
    <h1 class="title">Ticket Escalated: ${category.replace(/_/g, ' ').toUpperCase()}</h1>
    <p class="subtitle">AutoGenuine AI has escalated a customer conversation requiring immediate staff review.</p>

    <div class="info-card">
      <div class="info-row"><span class="info-label">Customer Name:</span><span class="info-value">${customerName || 'Customer'}</span></div>
      <div class="info-row"><span class="info-label">Customer Email:</span><span class="info-value">${customerEmail || 'N/A'}</span></div>
      <div class="info-row"><span class="info-label">Reason:</span><span class="info-value" style="color:#b91c1c;">${reason}</span></div>
      <div class="info-row"><span class="info-label">Priority:</span><span class="info-value">${priority.toUpperCase()}</span></div>
      ${orderRef ? `<div class="info-row"><span class="info-label">Order Ref:</span><span class="info-value">#${orderRef}</span></div>` : ''}
    </div>

    ${
      aiSummary
        ? `<div style="background:#fff7ed; border:1px solid #ffedd5; padding:16px; border-radius:8px; margin-bottom:20px;">
            <strong style="color:#c2410c; font-size:12px; text-transform:uppercase;">🤖 AI Summary:</strong>
            <p style="margin:8px 0 0 0; font-size:13px; color:#431407;">${aiSummary}</p>
          </div>`
        : ''
    }

    ${
      recommendedAction
        ? `<div style="background:#f0fdf4; border:1px solid #dcfce7; padding:16px; border-radius:8px; margin-bottom:20px;">
            <strong style="color:#15803d; font-size:12px; text-transform:uppercase;">💡 Recommended Action:</strong>
            <p style="margin:8px 0 0 0; font-size:13px; color:#14532d;">${recommendedAction}</p>
          </div>`
        : ''
    }
  `

  return {
    subject: `🚨 AI Escalation: ${reason} (${customerName || 'Customer'})`,
    html: emailWrapper({
      title: 'AI Support Escalation',
      contentHtml: html,
      actionText: 'Review Ticket in Workspace',
      actionUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/dashboard/messages`,
    }),
  }
}

/**
 * 5. Payment Success Email Template
 */
export function buildPaymentSuccessEmail({ orderRef, total, customerName, paymentMethod = 'Stripe' }) {
  const html = `
    <span class="badge badge-green">💳 PAYMENT VERIFIED SUCCESSFUL</span>
    <h1 class="title">Payment Received for Order #${orderRef}</h1>
    <p class="subtitle">Payment of <strong>Rs ${Number(total || 0).toLocaleString()}</strong> via ${paymentMethod} has been confirmed.</p>

    <div class="info-card">
      <div class="info-row"><span class="info-label">Order Reference:</span><span class="info-value">#${orderRef}</span></div>
      <div class="info-row"><span class="info-label">Customer Name:</span><span class="info-value">${customerName || 'Customer'}</span></div>
      <div class="info-row"><span class="info-label">Payment Status:</span><span class="info-value" style="color:#15803d;">PAID</span></div>
      <div class="info-row"><span class="info-label">Total Verified:</span><span class="info-value" style="color:#ea580c; font-size:16px;">Rs ${Number(total || 0).toLocaleString()}</span></div>
    </div>
  `

  return {
    subject: `💳 Payment Confirmed for Order #${orderRef} (Rs ${Number(total || 0).toLocaleString()})`,
    html: emailWrapper({
      title: 'Payment Confirmation',
      contentHtml: html,
      actionText: 'Track Order Status',
      actionUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/track?ref=${orderRef}`,
    }),
  }
}

/**
 * 6. Payment Failed Email Template
 */
export function buildPaymentFailedEmail({ orderRef, total, customerName, reason = 'Payment declined' }) {
  const html = `
    <span class="badge badge-red">⚠️ PAYMENT FAILED</span>
    <h1 class="title">Payment Issue for Order #${orderRef}</h1>
    <p class="subtitle">Payment transaction of <strong>Rs ${Number(total || 0).toLocaleString()}</strong> failed to process.</p>

    <div class="info-card">
      <div class="info-row"><span class="info-label">Order Reference:</span><span class="info-value">#${orderRef}</span></div>
      <div class="info-row"><span class="info-label">Customer Name:</span><span class="info-value">${customerName || 'Customer'}</span></div>
      <div class="info-row"><span class="info-label">Failure Reason:</span><span class="info-value" style="color:#b91c1c;">${reason}</span></div>
    </div>
  `

  return {
    subject: `⚠️ Payment Failed for Order #${orderRef}`,
    html: emailWrapper({
      title: 'Payment Failed',
      contentHtml: html,
      actionText: 'Retry Checkout / View Order',
      actionUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/my-orders`,
    }),
  }
}

/**
 * 7. Order Status Update Email Template
 */
export function buildOrderStatusEmail({ orderRef, status, customerName }) {
  const statusUpper = String(status || 'updated').toUpperCase().replace(/_/g, ' ')

  const html = `
    <span class="badge badge-brand">📦 ORDER STATUS UPDATE</span>
    <h1 class="title">Order #${orderRef} Status: ${statusUpper}</h1>
    <p class="subtitle">Dear ${customerName || 'Customer'}, your order status has been updated to <strong>${statusUpper}</strong>.</p>

    <div class="info-card">
      <div class="info-row"><span class="info-label">Order Number:</span><span class="info-value">#${orderRef}</span></div>
      <div class="info-row"><span class="info-label">New Status:</span><span class="info-value" style="color:#ea580c;">${statusUpper}</span></div>
    </div>
  `

  return {
    subject: `📦 Order #${orderRef} Status Update: ${statusUpper}`,
    html: emailWrapper({
      title: 'Order Status Update',
      contentHtml: html,
      actionText: 'Track Live Delivery',
      actionUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/track?ref=${orderRef}`,
    }),
  }
}
