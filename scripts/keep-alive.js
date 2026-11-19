/**
 * Optional Keep-Alive Ping Script
 * Run this to keep your Render instance awake from any machine:
 * node scripts/keep-alive.js https://your-app.onrender.com
 */

const targetArg = process.argv[2] || process.env.RENDER_APP_URL;

if (!targetArg) {
  console.log('Usage: node scripts/keep-alive.js https://your-app.onrender.com');
  process.exit(1);
}

const pingUrl = targetArg.replace(/\/$/, '') + '/healthz';
console.log(`Starting keep-alive pinger for: ${pingUrl}`);
console.log('Pinging every 12 minutes to prevent Render from sleeping...\n');

async function ping() {
  const time = new Date().toLocaleTimeString();
  try {
    const res = await fetch(pingUrl);
    const data = await res.json();
    console.log(`[${time}] Ping OK (HTTP ${res.status}) - Server Uptime: ${Math.round(data.uptime)}s`);
  } catch (err) {
    console.warn(`[${time}] Ping failed: ${err.message}`);
  }
}

ping();
setInterval(ping, 12 * 60 * 1000);
