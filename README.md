# Postman for MCP

A lightweight diagnostic proxy + visual dashboard for debugging secure Azure Function MCP servers.

## The Problem

When your AI agent (Copilot Chat, Claude, etc.) tries to connect to a remote MCP server hosted on Azure Functions, it goes through a complex auth flow:

```
Agent → [401 Challenge] → PRM Discovery → Token Request → Authenticated Call
```

When this breaks, you get generic errors. This tool shows you exactly **where** it breaks.

---

## Quick Start

### 1. Install

```bash
cd mcp-inspector
npm install
```

### 2. Run (point at your Azure Function)

```bash
TARGET=https://your-function.azurewebsites.net npm start
```

Or on Windows:

```powershell
$env:TARGET = "https://your-function.azurewebsites.net"
npm start
```

### 3. Redirect your MCP client

Change your MCP client's server URL from:
```
https://your-function.azurewebsites.net
```
to:
```
http://localhost:3000
```

### 4. Open the dashboard

```
http://localhost:3000/__inspector
```

---

## What You'll See

### Traffic Log (left panel)
Every HTTP request and response your agent makes, with:
- Direction (↑ request / ↓ response)
- Status codes (green = 2xx, red = 4xx/5xx)
- Tagged by type: `RPC` for JSON-RPC calls, `401` for auth challenges, `🔑` for authenticated requests, `SSE` for streaming connections

### Auth Flow (top-right panel)
Tracks the OAuth/Entra ID handshake in real-time:
```
① Request → ② 401 ⚠ → ③ PRM → ④ Token → ⑤ Authed → ✓ Done
```

### Payload Inspector (bottom-right panel)
Click any traffic entry to see:
- Full request/response headers (Bearer tokens are partially redacted)
- JSON-RPC method calls and responses with syntax highlighting
- `WWW-Authenticate` challenge details including the Protected Resource Metadata URL
- Raw SSE event data

---

## Configuration

| Environment Variable | Default | Description |
|----------------------|---------|-------------|
| `TARGET` | `https://example.azurewebsites.net` | Your Azure Function MCP server URL |
| `PORT` | `3000` | Local proxy port |

---

## Tested Against a Real Azure Functions MCP Server

We validated Postman for MCP against [@paulyuk](https://github.com/paulyuk)'s [`node-mcp-sdk-functions-hosting`](https://github.com/paulyuk/node-mcp-sdk-functions-hosting) — a reference implementation of an MCP server hosted on Azure Functions using the Node MCP SDK as a custom handler. This is the same pattern used in Microsoft's Azure Functions MCP quickstarts.

### What we ran

```
MCP test client
      ↓  POST /mcp
Postman for MCP  (localhost:3000)   ← dashboard at /__inspector
      ↓
Paul's Azure Functions server  (localhost:7071)
      ↓  text/event-stream (Streamable HTTP transport)
```

### How to reproduce it locally

**1. Start Paul's server**
```bash
git clone https://github.com/paulyuk/node-mcp-sdk-functions-hosting.git
cd node-mcp-sdk-functions-hosting
npm install
func start          # requires Azure Functions Core Tools v4
```
Server comes up at `http://localhost:7071/{*route}`

**2. Start Postman for MCP pointing at it**
```powershell
cd postman-for-mcp
$env:TARGET = "http://localhost:7071"
npm start
```

**3. Open the dashboard**
```
http://localhost:3000/__inspector
```

**4. Send a real MCP call**
```powershell
$headers = @{ "Content-Type" = "application/json"; "Accept" = "application/json, text/event-stream" }

# Initialize session
Invoke-WebRequest -Uri "http://localhost:3000/mcp" -Method POST -Headers $headers `
  -Body '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"postman-for-mcp","version":"1.0.0"},"capabilities":{}},"id":1}'

# List available tools
Invoke-WebRequest -Uri "http://localhost:3000/mcp" -Method POST -Headers $headers `
  -Body '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":2}'
```

### What we observed

- Paul's server uses the **Streamable HTTP transport** — responses come back as `Content-Type: text/event-stream` with `event: message` / `data: {...}` SSE framing, even for simple JSON-RPC calls. This is the transport mode most likely to cause silent client failures.
- The server is **fully stateless** — no `mcp-session-id` header is issued; each request is self-contained.
- The `initialize` response correctly advertises `tools.listChanged: true` capability.
- `tools/list` returned two real tools: `get-alerts` (NWS weather alerts by state) and `get-forecast` (forecast by lat/lon).
- All traffic — request headers, SSE-framed JSON-RPC payloads, and response metadata — was visible in real-time in the Postman for MCP dashboard.

The key discovery: **clients that don't include `Accept: application/json, text/event-stream`** get a clean `406 Not Acceptable` JSON-RPC error back. This is exactly the kind of subtle transport misconfiguration that Postman for MCP makes immediately visible.

---

## What Gets Redacted

Authorization header values are partially redacted in the UI (first 20 chars shown). Full tokens are never logged to disk — they're in-memory only.
