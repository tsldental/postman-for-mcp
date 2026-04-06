/**
 * server.js
 * MCP Traffic & Auth Inspector
 *
 * Usage:
 *   TARGET=https://your-function.azurewebsites.net PORT=3000 node server.js
 *
 * Then point your MCP client at http://localhost:3000 instead of the Azure Function.
 * Open http://localhost:3000/__inspector to see the dashboard.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createProxyMiddleware } = require('http-proxy-middleware');
const authTracker = require('./auth-tracker');

const TARGET = process.env.TARGET || 'https://example.azurewebsites.net';
const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();
const server = http.createServer(app);

// ── WebSocket broadcast to all connected dashboard clients ──────────────────
const wss = new WebSocketServer({ server, path: '/__ws' });
const dashboardClients = new Set();

wss.on('connection', (ws) => {
  dashboardClients.add(ws);
  // Send current auth session state on connect
  ws.send(JSON.stringify({ type: 'auth_sessions', data: authTracker.getSummary() }));
  ws.on('close', () => dashboardClients.delete(ws));
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of dashboardClients) {
    if (client.readyState === 1 /* OPEN */) client.send(payload);
  }
}

// Forward auth tracker events to dashboard
authTracker.on('update', (session) => {
  broadcast({ type: 'auth_update', data: session });
});

// ── Traffic log ─────────────────────────────────────────────────────────────
const trafficLog = [];
const MAX_LOG = 200;

function logEntry(entry) {
  entry.id = Date.now() + Math.random().toString(36).slice(2, 6);
  entry.ts = Date.now();
  trafficLog.unshift(entry);
  if (trafficLog.length > MAX_LOG) trafficLog.length = MAX_LOG;
  broadcast({ type: 'traffic', data: entry });
}

// ── Dashboard static files ───────────────────────────────────────────────────
app.use('/__inspector', express.static(path.join(__dirname, 'public')));

// ── REST API for dashboard ───────────────────────────────────────────────────
app.get('/__api/log', (_req, res) => res.json(trafficLog));
app.get('/__api/auth', (_req, res) => res.json(authTracker.getSummary()));
app.get('/__api/config', (_req, res) => res.json({ target: TARGET, port: PORT }));

// ── Proxy middleware ─────────────────────────────────────────────────────────
const proxy = createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  selfHandleResponse: false,

  on: {
    proxyReq: (proxyReq, req) => {
      const { key } = authTracker.onRequest(req);
      req._authSessionKey = key;

      // Capture request body for JSON-RPC logging
      let body = [];
      req.on('data', (chunk) => body.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(body).toString();
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { /* not JSON */ }

        const authHeader = req.headers['authorization'] || '';
        const tokenSnippet = authHeader.startsWith('Bearer ')
          ? authHeader.slice(7, 20) + '…'
          : null;

        logEntry({
          direction: 'request',
          method: req.method,
          path: req.path,
          statusCode: null,
          authSessionKey: key,
          hasToken: !!tokenSnippet,
          tokenSnippet,
          contentType: req.headers['content-type'] || null,
          headers: sanitizeHeaders(req.headers),
          body: parsed || (raw.length < 4096 ? raw : '[body too large]'),
          isJsonRpc: parsed?.jsonrpc === '2.0',
          rpcMethod: parsed?.method || null,
        });
      });
    },

    proxyRes: (proxyRes, req, res) => {
      const key = req._authSessionKey;
      authTracker.onResponse(key, proxyRes.statusCode, proxyRes.headers);

      const isSSE = (proxyRes.headers['content-type'] || '').includes('text/event-stream');
      const isStream = isSSE || (proxyRes.headers['transfer-encoding'] || '').includes('chunked');

      // Collect response body (only for non-streaming responses)
      if (!isStream) {
        let body = [];
        proxyRes.on('data', (chunk) => body.push(chunk));
        proxyRes.on('end', () => {
          const raw = Buffer.concat(body).toString();
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) { /* not JSON */ }

          logEntry({
            direction: 'response',
            method: req.method,
            path: req.path,
            statusCode: proxyRes.statusCode,
            authSessionKey: key,
            contentType: proxyRes.headers['content-type'] || null,
            headers: sanitizeHeaders(proxyRes.headers),
            body: parsed || (raw.length < 4096 ? raw : '[body too large]'),
            isJsonRpc: parsed?.jsonrpc === '2.0',
            rpcMethod: parsed?.method || null,
            wwwAuthenticate: proxyRes.headers['www-authenticate'] || null,
          });
        });
      } else {
        // For SSE / streaming: log the connection open event
        logEntry({
          direction: 'response',
          method: req.method,
          path: req.path,
          statusCode: proxyRes.statusCode,
          authSessionKey: key,
          contentType: proxyRes.headers['content-type'] || null,
          headers: sanitizeHeaders(proxyRes.headers),
          body: null,
          isSSE: true,
          streaming: true,
        });

        // Track SSE events
        let sseBuffer = '';
        proxyRes.on('data', (chunk) => {
          sseBuffer += chunk.toString();
          const events = sseBuffer.split('\n\n');
          sseBuffer = events.pop(); // last may be incomplete
          for (const evt of events) {
            if (!evt.trim()) continue;
            broadcast({
              type: 'sse_event',
              data: {
                path: req.path,
                authSessionKey: key,
                raw: evt,
                ts: Date.now(),
              },
            });
          }
        });

        proxyRes.on('end', () => {
          broadcast({
            type: 'sse_disconnect',
            data: { path: req.path, authSessionKey: key, ts: Date.now() },
          });
        });

        proxyRes.on('error', (err) => {
          broadcast({
            type: 'sse_error',
            data: { path: req.path, authSessionKey: key, error: err.message, ts: Date.now() },
          });
        });
      }
    },

    error: (err, req, res) => {
      logEntry({
        direction: 'error',
        method: req.method,
        path: req.path,
        statusCode: 502,
        authSessionKey: req._authSessionKey,
        error: err.message,
      });
      res.status(502).json({ error: 'Proxy error', message: err.message });
    },
  },
});

// Apply proxy to all non-inspector routes
app.use((req, res, next) => {
  if (req.path.startsWith('/__')) return next();
  proxy(req, res, next);
});

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🔍 MCP Inspector running`);
  console.log(`   Proxying → ${TARGET}`);
  console.log(`   Dashboard → http://localhost:${PORT}/__inspector\n`);
});

// ── Helpers ──────────────────────────────────────────────────────────────────
const REDACT = ['authorization', 'x-ms-token', 'x-api-key', 'cookie'];

function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (REDACT.includes(k.toLowerCase())) {
      out[k] = typeof v === 'string' && v.startsWith('Bearer ')
        ? `Bearer ${v.slice(7, 20)}…[redacted]`
        : '[redacted]';
    } else {
      out[k] = v;
    }
  }
  return out;
}
