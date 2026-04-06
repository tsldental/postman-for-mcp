# MCP Traffic & Auth Inspector

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

## What Gets Redacted

Authorization header values are partially redacted in the UI (first 20 chars shown). Full tokens are never logged to disk — they're in-memory only.
