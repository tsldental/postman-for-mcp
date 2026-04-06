/**
 * mock-mcp-server.js
 * Minimal HTTP MCP server for testing Postman for MCP.
 * Speaks JSON-RPC 2.0 over HTTP, simulates a tools/list and tools/call response.
 */

const http = require('http');

const TOOLS = [
  { name: 'get_issues', description: 'List GitHub issues', inputSchema: { type: 'object', properties: { repo: { type: 'string' } } } },
  { name: 'create_issue', description: 'Create a GitHub issue', inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } } },
];

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405); res.end(); return;
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let rpc;
    try { rpc = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }

    let result;
    switch (rpc.method) {
      case 'initialize':
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0.0' } };
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call':
        result = { content: [{ type: 'text', text: `Called tool "${rpc.params?.name}" with args: ${JSON.stringify(rpc.params?.arguments)}` }] };
        break;
      default:
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${rpc.method}` }, id: rpc.id }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', result, id: rpc.id }));
  });
});

server.listen(8787, () => console.log('🧪 Mock MCP server running on http://localhost:8787'));
