const { checkPasscode } = require('./security/passcodeManager.cjs');
const {
  createAuthorizedSession,
  verifySession,
  createSingleUseTicket,
  consumeSingleUseTicket,
} = require('./security/sessionManager.cjs');
const { generateEncryptedTilePackage } = require('./security/tiledImageService.cjs');
const { resolvePrivateImage } = require('./security/imageDelivery.cjs');
const { evaluateRequestAbuse, isSuspiciousClient } = require('./security/abuseDefender.cjs');
const { recordForensicEvent } = require('./security/forensicsLog.cjs');
const { getClientIp } = require('./security/trustProxy.cjs');
const { checkUnlockRateLimit } = require('./security/releaseRateLimiter.cjs');

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 50000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * Security Middleware
 * Gated passcode authentication, AES-GCM tiled delivery, abuse defense, and forensics.
 */
function securityMiddleware(req, res, next) {
  const clientIp = getClientIp(req);
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // Global Hardened Security Headers on all responses
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // 1. Direct Static Access Block
  if (
    pathname.startsWith('/photos/') ||
    pathname.startsWith('/memories/') ||
    pathname.startsWith('/storage/')
  ) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  // 2. Passcode Gate Unlock Endpoint: POST /api/auth/unlock
  if (pathname === '/api/auth/unlock' && req.method === 'POST') {
    const burstCheck = checkUnlockRateLimit(clientIp);
    if (!burstCheck.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(burstCheck.retryAfterSeconds || 60),
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({
        error: 'TOO_MANY_REQUESTS',
        message: 'Too many unlock requests. Please wait before retrying.',
      }));
      return;
    }

    parseJsonBody(req).then((body) => {
      const passcode = body.passcode || '';
      const checkResult = checkPasscode(passcode, clientIp);

      if (!checkResult.success) {
        const statusCode = checkResult.reason === 'LOCKED_OUT' ? 429 : 401;
        recordForensicEvent({
          action: 'UNLOCK_FAILED',
          ip: clientIp,
          resource: 'passcode_gate',
          detail: checkResult.reason,
        });

        res.writeHead(statusCode, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(checkResult));
        return;
      }

      // Passcode verified: Create authorized session
      const session = createAuthorizedSession(clientIp);
      recordForensicEvent({
        action: 'UNLOCK_SUCCESS',
        sid: session.sid,
        ip: clientIp,
        resource: 'passcode_gate',
      });

      const cookieHeader = `pinkverse_secure_session=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`;

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': cookieHeader,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(
        JSON.stringify({
          status: 'unlocked',
          token: session.token,
          sessionKey: session.sessionKey,
          expiresAt: session.expiresAt,
        })
      );
    });
    return;
  }

  // 3. Guest Session Auto-Issue Endpoint: POST /api/auth/session (Default access)
  if (pathname === '/api/auth/session') {
    const session = createAuthorizedSession(clientIp);
    const cookieHeader = `pinkverse_secure_session=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`;

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieHeader,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(
      JSON.stringify({
        status: 'authenticated',
        token: session.token,
        sessionKey: session.sessionKey,
        expiresAt: session.expiresAt,
      })
    );
    return;
  }

  // 4. Session Key Retrieval: GET /api/auth/session-key
  if (pathname === '/api/auth/session-key') {
    const verification = verifySession(req);
    if (!verification.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        sessionKey: verification.session.sessionKey,
        expiresAt: verification.session.exp,
      })
    );
    return;
  }

  // 5. Single-Use Ticket Request: POST /api/v2/photos/:imageId/ticket
  if (pathname.startsWith('/api/v2/photos/') && pathname.endsWith('/ticket')) {
    const parts = pathname.split('/');
    const imageId = parts[4];

    const verification = verifySession(req);
    if (!verification.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const requestedSize = urlObj.searchParams.get('size') || 'large';

    // Abuse defense check
    const abuseCheck = evaluateRequestAbuse(verification.session, clientIp, imageId, requestedSize);
    if (!abuseCheck.allowed) {
      const status = abuseCheck.status || (abuseCheck.reason.includes('REVOKED') ? 403 : 429);
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (abuseCheck.retryAfter) {
        headers['Retry-After'] = String(abuseCheck.retryAfter);
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify({ error: abuseCheck.message, reason: abuseCheck.reason }));
      return;
    }

    const ticketResult = createSingleUseTicket(verification.session.sid, imageId);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(ticketResult));
    return;
  }

  // 6. Encrypted Tiled Delivery: GET /api/v2/photos/:imageId/tiles
  if (pathname.startsWith('/api/v2/photos/') && pathname.endsWith('/tiles')) {
    const parts = pathname.split('/');
    const imageId = parts[4];
    const ticket = urlObj.searchParams.get('ticket');

    const verification = verifySession(req);
    if (!verification.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Validate single-use ticket (Prevents replay attacks)
    const ticketCheck = consumeSingleUseTicket(ticket, verification.session.sid, imageId);
    if (!ticketCheck.valid) {
      recordForensicEvent({
        action: 'TICKET_REPLAY_BLOCKED',
        sid: verification.session.sid,
        ip: clientIp,
        resource: imageId,
        detail: ticketCheck.reason,
      });
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Forbidden: Invalid or replayed ticket' }));
      return;
    }

    const requestedSize = urlObj.searchParams.get('size') || 'large';

    // Generate scrambled, AES-256-GCM encrypted tile packet
    generateEncryptedTilePackage(imageId, verification.session, requestedSize)
      .then((encryptedBuffer) => {
        if (!encryptedBuffer) {
          res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'Photo not found' }));
          return;
        }

        recordForensicEvent({
          action: 'DELIVER_ENCRYPTED_TILES',
          sid: verification.session.sid,
          ip: clientIp,
          resource: imageId,
          detail: `tiles_packet_size=${encryptedBuffer.length}&size=${requestedSize}`,
        });

        // Short-term private browser caching (3-5 minutes) with stale-while-revalidate
        const cacheControl =
          requestedSize === 'large'
            ? 'private, max-age=180, stale-while-revalidate=60'
            : 'private, max-age=300, stale-while-revalidate=60';

        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': cacheControl,
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Referrer-Policy': 'no-referrer',
        });
        res.end(encryptedBuffer);
      })
      .catch((err) => {
        console.error('[TiledDelivery] Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Internal processing error' }));
      });
    return;
  }

  // 7. Backward-Compatible Private Images Endpoint: GET /api/private-images/:imageId
  if (pathname.startsWith('/api/private-images/')) {
    const imageId = pathname.replace('/api/private-images/', '').split('/')[0];
    const size = urlObj.searchParams.get('size') || 'medium';

    const verification = verifySession(req);
    if (!verification.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const abuseCheck = evaluateRequestAbuse(verification.session, clientIp, imageId);
    if (!abuseCheck.allowed) {
      const status = abuseCheck.reason.includes('REVOKED') ? 403 : 429;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: abuseCheck.message }));
      return;
    }

    resolvePrivateImage(imageId, size)
      .then((result) => {
        if (result.status !== 200) {
          res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: result.error }));
          return;
        }

        res.writeHead(200, result.headers);
        res.end(result.buffer);
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      });
    return;
  }

  next();
}

module.exports = {
  securityMiddleware,
};
