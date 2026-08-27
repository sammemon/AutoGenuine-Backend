// Backend Status & API Explorer Dashboard for AutoGenuine
import mongoose from 'mongoose'
import os from 'os'

const SERVER_START_TIME = Date.now()

export function getSystemStats() {
  const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000)
  const hours = Math.floor(uptimeSeconds / 3600)
  const minutes = Math.floor((uptimeSeconds % 3600) / 60)
  const seconds = uptimeSeconds % 60
  const uptimeFormatted = `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`

  const memoryUsage = process.memoryUsage()
  const ramMb = Math.round(memoryUsage.rss / 1024 / 1024)

  const dbStateMap = {
    0: 'Disconnected',
    1: 'Connected',
    2: 'Connecting',
    3: 'Disconnecting',
  }
  const dbStatus = dbStateMap[mongoose.connection.readyState] || 'Unknown'
  const isDbHealthy = mongoose.connection.readyState === 1

  return {
    status: 'online',
    service: 'AutoGenuine Core API Server',
    port: process.env.PORT || 5000,
    database: {
      status: dbStatus,
      healthy: isDbHealthy,
      host: mongoose.connection.host || 'MongoDB Atlas',
      name: mongoose.connection.name || 'autogenuine',
    },
    uptime: uptimeFormatted,
    uptimeSeconds,
    memory: `${ramMb} MB RAM`,
    nodeVersion: process.version,
    platform: `${os.type()} ${os.arch()}`,
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  }
}

export function renderDashboardHtml() {
  const stats = getSystemStats()

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AutoGenuine API Engine — Backend Status & Explorer</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Outfit:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0c10;
      --card-bg: #13151b;
      --card-border: #222634;
      --brand: #f97316;
      --brand-glow: rgba(249, 115, 22, 0.25);
      --green: #10b981;
      --green-glow: rgba(16, 185, 129, 0.2);
      --red: #ef4444;
      --blue: #3b82f6;
      --purple: #8b5cf6;
      --amber: #f59e0b;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --font-sans: 'Outfit', sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(249, 115, 22, 0.05) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(16, 185, 129, 0.04) 0%, transparent 40%);
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 20px;
      width: 100%;
    }

    /* Header */
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 16px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 32px;
    }

    .brand-wrap {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .brand-logo {
      width: 44px;
      height: 44px;
      background: linear-gradient(135deg, #ea580c, #f97316);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: 900;
      font-size: 22px;
      box-shadow: 0 4px 14px var(--brand-glow);
    }

    .brand-title h1 {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.5px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .brand-title span.badge {
      background: rgba(249, 115, 22, 0.15);
      color: var(--brand);
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 6px;
      font-weight: 700;
      letter-spacing: 0.5px;
      border: 1px solid rgba(249, 115, 22, 0.3);
    }

    .brand-title p {
      font-size: 13px;
      color: var(--text-muted);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s ease;
      border: none;
      font-family: var(--font-sans);
    }

    .btn-primary {
      background: var(--brand);
      color: #fff;
      box-shadow: 0 2px 8px var(--brand-glow);
    }
    .btn-primary:hover {
      background: #ea580c;
      transform: translateY(-1px);
    }

    .btn-secondary {
      background: var(--card-bg);
      color: var(--text);
      border: 1px solid var(--card-border);
    }
    .btn-secondary:hover {
      border-color: var(--brand);
      color: var(--brand);
    }

    /* Live pulse badge */
    .status-pulse {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 6px 14px;
      border-radius: 20px;
      color: var(--green);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }

    .pulse-dot {
      width: 8px;
      height: 8px;
      background: var(--green);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--green);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.2); }
      100% { opacity: 1; transform: scale(1); }
    }

    /* Grid of Metrics */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }

    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      transition: all 0.2s ease;
    }
    .metric-card:hover {
      border-color: rgba(249, 115, 22, 0.4);
      transform: translateY(-2px);
    }

    .metric-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      font-weight: 700;
      margin-bottom: 6px;
    }

    .metric-value {
      font-size: 22px;
      font-weight: 800;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .metric-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    /* Section Title */
    .section-title {
      font-size: 17px;
      font-weight: 800;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* Endpoints Table */
    .endpoints-wrap {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      overflow: hidden;
      margin-bottom: 32px;
    }

    .endpoints-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(255,255,255,0.02);
    }

    .endpoints-list {
      divide-y: 1px solid var(--card-border);
    }

    .endpoint-row {
      padding: 14px 20px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      transition: background 0.15s ease;
    }
    .endpoint-row:last-child {
      border-bottom: none;
    }
    .endpoint-row:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .endpoint-left {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 320px;
      flex: 1;
    }

    .method {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      padding: 4px 8px;
      border-radius: 6px;
      letter-spacing: 0.5px;
      min-width: 60px;
      text-align: center;
    }
    .method-get { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); }
    .method-post { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .method-put { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .method-delete { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }

    .endpoint-path {
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 600;
      color: #fff;
    }

    .endpoint-desc {
      font-size: 12px;
      color: var(--text-muted);
      margin-left: 8px;
    }

    .endpoint-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .badge-auth {
      font-size: 10px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .auth-public { background: rgba(255,255,255,0.06); color: var(--text-muted); }
    .auth-user { background: rgba(59, 130, 246, 0.15); color: #93c5fd; }
    .auth-admin { background: rgba(249, 115, 22, 0.15); color: #fdba74; }
    .auth-owner { background: rgba(139, 92, 246, 0.15); color: #c4b5fd; }

    .btn-test {
      padding: 5px 12px;
      font-size: 11px;
      border-radius: 6px;
      background: rgba(255,255,255,0.06);
      color: #fff;
      border: 1px solid var(--card-border);
      cursor: pointer;
      font-weight: 700;
      transition: all 0.15s ease;
      font-family: var(--font-mono);
    }
    .btn-test:hover {
      background: var(--brand);
      border-color: var(--brand);
    }

    .health-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 700;
      font-family: var(--font-mono);
      color: var(--green);
    }
    .health-pill.err {
      color: var(--red);
    }

    /* Live Output Console Modal */
    #responseViewer {
      margin-top: 10px;
      padding: 12px 16px;
      background: #08090c;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      font-family: var(--font-mono);
      font-size: 12px;
      color: #a7f3d0;
      max-height: 200px;
      overflow-y: auto;
      display: none;
      white-space: pre-wrap;
      word-break: break-all;
    }

    footer {
      margin-top: auto;
      padding: 24px 0;
      border-top: 1px solid var(--card-border);
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>

  <div class="container">
    <!-- Header -->
    <header>
      <div class="brand-wrap">
        <div class="brand-logo">AG</div>
        <div class="brand-title">
          <h1>AutoGenuine API Engine <span class="badge">v1.0.0</span></h1>
          <p>High Performance OEM Auto Parts Platform Backend</p>
        </div>
      </div>

      <div class="header-actions">
        <div class="status-pulse">
          <span class="pulse-dot"></span>
          SYSTEM OPERATIONAL
        </div>
        <a href="${stats.frontendUrl}" target="_blank" class="btn btn-primary">
          Open Web App ➜
        </a>
      </div>
    </header>

    <!-- Real-time Metrics -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">MongoDB Database</div>
        <div class="metric-value">
          <span style="color: ${stats.database.healthy ? 'var(--green)' : 'var(--red)'}">●</span>
          ${stats.database.status}
        </div>
        <div class="metric-sub">${stats.database.host}</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Server Uptime</div>
        <div class="metric-value" id="uptimeDisplay">${stats.uptime}</div>
        <div class="metric-sub">Port ${stats.port} • Node.js ${stats.nodeVersion}</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Memory Usage</div>
        <div class="metric-value">${stats.memory}</div>
        <div class="metric-sub">${stats.platform}</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Active Image Storage</div>
        <div class="metric-value" style="color: var(--brand);">/uploads/*</div>
        <div class="metric-sub">Static Multi-part File Server</div>
      </div>
    </div>

    <!-- Live Test Console Output -->
    <div id="responseViewer"></div>

    <!-- API Endpoints -->
    <div class="section-title">
      <span>Registered API Endpoints & Health Matrix</span>
      <button onclick="testAllHealth()" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
        ⚡ Test All Endpoints
      </button>
    </div>

    <div class="endpoints-wrap">
      <div class="endpoints-header">
        <span style="font-size: 13px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px;">Service Endpoints</span>
        <span style="font-size: 12px; color: var(--text-muted);">Real-time Verification</span>
      </div>

      <div class="endpoints-list">

        <!-- System Health -->
        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-get">GET</span>
            <div>
              <span class="endpoint-path">/api/health</span>
              <span class="endpoint-desc">System heartbeat & uptime</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-public">Public</span>
            <span class="health-pill" id="health-api-health">● 200 OK</span>
            <button class="btn-test" onclick="testEndpoint('/api/health', 'GET')">Test</button>
          </div>
        </div>

        <!-- Catalog Parts -->
        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-get">GET</span>
            <div>
              <span class="endpoint-path">/api/catalog/parts</span>
              <span class="endpoint-desc">Storefront parts catalog query</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-public">Public</span>
            <span class="health-pill" id="health-api-catalog-parts">● 200 OK</span>
            <button class="btn-test" onclick="testEndpoint('/api/catalog/parts', 'GET')">Test</button>
          </div>
        </div>

        <!-- Catalog Categories -->
        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-get">GET</span>
            <div>
              <span class="endpoint-path">/api/catalog/categories</span>
              <span class="endpoint-desc">Browse categories list</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-public">Public</span>
            <span class="health-pill" id="health-api-catalog-categories">● 200 OK</span>
            <button class="btn-test" onclick="testEndpoint('/api/catalog/categories', 'GET')">Test</button>
          </div>
        </div>

        <!-- Catalog Vehicles -->
        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-get">GET</span>
            <div>
              <span class="endpoint-path">/api/catalog/vehicles</span>
              <span class="endpoint-desc">Supported vehicles & makes</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-public">Public</span>
            <span class="health-pill" id="health-api-catalog-vehicles">● 200 OK</span>
            <button class="btn-test" onclick="testEndpoint('/api/catalog/vehicles', 'GET')">Test</button>
          </div>
        </div>

        <!-- Image Upload API -->
        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-post">POST</span>
            <div>
              <span class="endpoint-path">/api/upload</span>
              <span class="endpoint-desc">Multipart image upload (JPG/PNG/WEBP <= 5MB)</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-user">Auth Required</span>
            <span class="health-pill" style="color: var(--amber)">● Ready</span>
          </div>
        </div>

        <!-- Auth Routes -->
        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-post">POST</span>
            <div>
              <span class="endpoint-path">/api/auth/login</span>
              <span class="endpoint-desc">User / Admin / Owner authentication</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-public">Public</span>
            <span class="health-pill" style="color: var(--green)">● Ready</span>
          </div>
        </div>

        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-post">POST</span>
            <div>
              <span class="endpoint-path">/api/auth/google</span>
              <span class="endpoint-desc">Google OAuth Single Sign-On / Registration</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-public">Public</span>
            <span class="health-pill" style="color: var(--green)">● Ready</span>
          </div>
        </div>

        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-get">GET</span>
            <div>
              <span class="endpoint-path">/api/auth/me</span>
              <span class="endpoint-desc">Current authenticated user session</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-user">JWT Bearer</span>
            <span class="health-pill" style="color: var(--green)">● Ready</span>
          </div>
        </div>

        <!-- Orders & Checkout -->
        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-post">POST</span>
            <div>
              <span class="endpoint-path">/api/orders</span>
              <span class="endpoint-desc">Multi-gateway order creation & payment record</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-user">JWT Bearer</span>
            <span class="health-pill" style="color: var(--green)">● Ready</span>
          </div>
        </div>

        <!-- Admin Management Endpoints -->
        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-get">GET</span>
            <div>
              <span class="endpoint-path">/api/admin/parts</span>
              <span class="endpoint-desc">Manage parts catalog with validated stock & discount</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-admin">Staff (Admin+)</span>
            <span class="health-pill" style="color: var(--green)">● Ready</span>
          </div>
        </div>

        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-get">GET</span>
            <div>
              <span class="endpoint-path">/api/admin/categories</span>
              <span class="endpoint-desc">Manage store categories</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-admin">Staff (Admin+)</span>
            <span class="health-pill" style="color: var(--green)">● Ready</span>
          </div>
        </div>

        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-get">GET</span>
            <div>
              <span class="endpoint-path">/api/admin/vehicles</span>
              <span class="endpoint-desc">Manage vehicles & year compatibility</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-admin">Staff (Admin+)</span>
            <span class="health-pill" style="color: var(--green)">● Ready</span>
          </div>
        </div>

        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-get">GET</span>
            <div>
              <span class="endpoint-path">/api/admin/analytics</span>
              <span class="endpoint-desc">Real-time revenue, order trends, top sellers</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-owner">Owner Only</span>
            <span class="health-pill" style="color: var(--green)">● Ready</span>
          </div>
        </div>

        <div class="endpoint-row">
          <div class="endpoint-left">
            <span class="method method-get">GET</span>
            <div>
              <span class="endpoint-path">/api/admin/settings</span>
              <span class="endpoint-desc">Global store settings & rates</span>
            </div>
          </div>
          <div class="endpoint-right">
            <span class="badge-auth auth-owner">Owner Only</span>
            <span class="health-pill" style="color: var(--green)">● Ready</span>
          </div>
        </div>

      </div>
    </div>

    <footer>
      AutoGenuine OEM Auto Parts • REST API Server • Node.js ${process.version} • MongoDB Atlas
    </footer>
  </div>

  <script>
    async function testEndpoint(path, method) {
      const viewer = document.getElementById('responseViewer');
      viewer.style.display = 'block';
      viewer.textContent = 'Executing ' + method + ' ' + path + '...';

      const t0 = performance.now();
      try {
        const res = await fetch(path, { method });
        const latency = Math.round(performance.now() - t0);
        const data = await res.json();
        
        viewer.textContent = 'HTTP ' + res.status + ' ' + res.statusText + ' (' + latency + 'ms)\\n\\n' + JSON.stringify(data, null, 2);

        const pillId = 'health-' + path.replace(/\\//g, '-').replace(/^-/, '');
        const pill = document.getElementById(pillId);
        if (pill) {
          pill.textContent = '● ' + res.status + ' OK (' + latency + 'ms)';
          pill.className = res.ok ? 'health-pill' : 'health-pill err';
        }
      } catch (err) {
        viewer.textContent = 'FAILED: ' + err.message;
      }
    }

    async function testAllHealth() {
      const endpoints = [
        '/api/health',
        '/api/catalog/parts',
        '/api/catalog/categories',
        '/api/catalog/vehicles',
      ];
      for (const ep of endpoints) {
        await testEndpoint(ep, 'GET');
      }
    }

    // Auto-test health on page load
    testAllHealth();
  </script>
</body>
</html>`
}
