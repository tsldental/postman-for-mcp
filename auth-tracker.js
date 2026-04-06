/**
 * auth-tracker.js
 * Tracks the OAuth / Entra ID handshake stages for a given request session.
 *
 * Stages:
 *   1. initial_request   – MCP client sends first call (no token yet)
 *   2. challenge_401     – Server returns 401 + WWW-Authenticate header
 *   3. prm_discovery     – Client fetches Protected Resource Metadata
 *   4. token_request     – Client exchanges code/credentials for a token
 *   5. authenticated     – Client retries with Bearer token → success
 */

const { EventEmitter } = require('events');

class AuthTracker extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // keyed by a session ID derived from client IP + path
  }

  _sessionKey(req) {
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    // Group by IP + base path (strip query string)
    return `${ip}::${req.path.split('?')[0]}`;
  }

  getOrCreate(key) {
    if (!this.sessions.has(key)) {
      this.sessions.set(key, {
        key,
        startedAt: Date.now(),
        stage: 'initial_request',
        steps: [],
        token: null,
        resourceMetadataUrl: null,
      });
    }
    return this.sessions.get(key);
  }

  recordStep(sessionKey, step) {
    const session = this.getOrCreate(sessionKey);
    step.ts = Date.now();
    session.steps.push(step);
    session.stage = step.stage;
    this.emit('update', session);
    return session;
  }

  // Called when we see the outgoing request
  onRequest(req) {
    const key = this._sessionKey(req);
    const session = this.getOrCreate(key);
    const hasToken = !!(req.headers['authorization'] || '').startsWith('Bearer ');
    const isPRM = req.path.includes('/.well-known/oauth-protected-resource');
    const isTokenEndpoint = req.path.includes('/token') || req.path.includes('/oauth2/');

    if (isPRM) {
      this.recordStep(key, { stage: 'prm_discovery', label: 'PRM Metadata Fetch', path: req.path });
    } else if (isTokenEndpoint && req.method === 'POST') {
      this.recordStep(key, { stage: 'token_request', label: 'Token Request', path: req.path });
    } else if (hasToken) {
      this.recordStep(key, { stage: 'authenticated', label: 'Authenticated Request', path: req.path });
    } else if (session.stage === 'initial_request') {
      this.recordStep(key, { stage: 'initial_request', label: 'Initial MCP Request', path: req.path });
    }

    return { key, session };
  }

  // Called when we see the proxy response
  onResponse(sessionKey, statusCode, headers) {
    if (statusCode === 401) {
      const wwwAuth = headers['www-authenticate'] || '';
      const resourceMetadataUrl = this._extractPRMUrl(wwwAuth);
      const session = this.getOrCreate(sessionKey);
      session.resourceMetadataUrl = resourceMetadataUrl;
      this.recordStep(sessionKey, {
        stage: 'challenge_401',
        label: '401 Challenge Received',
        statusCode,
        wwwAuthenticate: wwwAuth,
        resourceMetadataUrl,
      });
    }
    if (statusCode >= 200 && statusCode < 300) {
      const session = this.sessions.get(sessionKey);
      if (session && session.stage === 'authenticated') {
        this.recordStep(sessionKey, { stage: 'success', label: 'Auth Flow Complete ✓', statusCode });
      }
    }
  }

  _extractPRMUrl(wwwAuth) {
    const match = wwwAuth.match(/resource_metadata="([^"]+)"/i);
    return match ? match[1] : null;
  }

  getSummary() {
    return Array.from(this.sessions.values()).map(s => ({
      key: s.key,
      stage: s.stage,
      stepCount: s.steps.length,
      startedAt: s.startedAt,
      lastStep: s.steps[s.steps.length - 1] || null,
    }));
  }
}

module.exports = new AuthTracker();
