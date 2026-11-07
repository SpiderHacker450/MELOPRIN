const {
  createAuthorizedSession,
  verifySession,
  createSingleUseTicket,
  consumeSingleUseTicket,
} = require('./security/sessionManager.cjs');
const { generateEncryptedTilePackage } = require('./security/tiledImageService.cjs');
const { resolvePrivateImage, getAuthorizedDerivative } = require('./security/imageDelivery.cjs');
const { evaluateRequestAbuse, isSuspiciousClient } = require('./security/abuseDefender.cjs');
const { recordForensicEvent } = require('./security/forensicsLog.cjs');
const { getClientIp } = require('./security/trustProxy.cjs');

function isOriginAllowed(req) {
  const secFetchSite = req.headers['sec-fetch-site'];
  const origin = req.headers['origin'];
  const host = req.headers['host'];

  // Sec-Fetch-Site browser check: cross-site requests only allowed from GitHub Pages
  if (secFetchSite && secFetchSite === 'cross-site') {
    if (!origin || !origin.startsWith('https://spiderhacker450.github.io')) {
      return false;
    }
  }

  // Origin header check if present
  if (origin) {
    const allowedOrigins = [
      'https://spiderhacker450.github.io',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
    ];
    if (host) {
      allowedOrigins.push(`http://${host}`);
      allowedOrigins.push(`https://${host}`);
    }
    const isAllowed =
      allowedOrigins.includes(origin) ||
      /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin);
    if (!isAllowed) {
      return false;
    }
  }

  return true;
}

function sendGenericUnauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

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
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

  // 1. Direct Static Access Block
  if (
    pathname.startsWith('/photos/') ||
    pathname.startsWith('/memories/') ||
    pathname.startsWith('/storage/')
  ) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  // 2. Photo & Audio Cross-Origin & Hotlink Gate
  const isPhotoRoute =
    pathname.startsWith('/api/v2/photos') ||
    pathname.startsWith('/api/photos') ||
    pathname.startsWith('/api/private-images');
  const isAudioRoute = pathname.startsWith('/audio/') || pathname.endsWith('.mp3');

  if ((isPhotoRoute || isAudioRoute) && !isOriginAllowed(req)) {
    sendGenericUnauthorized(res);
    return;
  }

  // 3. Audio & Media Session Gate: Prohibit unauthenticated scraping
  if (isAudioRoute) {
    const verification = verifySession(req);
    if (!verification.valid) {
      sendGenericUnauthorized(res);
      return;
    }
  }

  // 4. Guest Session Auto-Issue Endpoint: POST /api/auth/session
  if (pathname === '/api/auth/session') {
    const session = createAuthorizedSession(clientIp);
    const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.connection?.encrypted || req.socket?.encrypted;
    const cookieHeader = `pinkverse_secure_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=14400${isSecure ? '; Secure' : ''}`;

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieHeader,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
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

  // 6b. Photo Metadata Endpoint: GET /api/v2/photos/:imageId/metadata
  if (pathname.startsWith('/api/v2/photos/') && pathname.endsWith('/metadata')) {
    const parts = pathname.split('/');
    const imageId = parts[4];
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(JSON.stringify({ imageId, status: 'ready' }));
    return;
  }

  // 6c. High-Performance Clean Authorized Derivative Delivery: GET /api/v2/photos/:imageId (and GET /api/photos/:imageId)
  // Delivers pre-generated derivative (thumb 400px or viewing 1280px) in a single authorized HTTP response with strong ETag and 1h private cache.
  if (
    (pathname.startsWith('/api/v2/photos/') || pathname.startsWith('/api/photos/')) &&
    !pathname.endsWith('/ticket') &&
    !pathname.endsWith('/tiles') &&
    !pathname.endsWith('/metadata')
  ) {
    const imageId = pathname.replace(/^\/api\/(v2\/)?photos\//, '').split('/')[0];

    const verification = verifySession(req);
    if (!verification.valid) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const requestedSize = urlObj.searchParams.get('size') || 'thumb';

    // Token-bucket abuse defense check
    const abuseCheck = evaluateRequestAbuse(verification.session, clientIp, imageId, requestedSize);
    if (!abuseCheck.allowed) {
      const status = abuseCheck.status || (abuseCheck.reason.includes('REVOKED') ? 403 : 429);
      const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Referrer-Policy': 'no-referrer',
      };
      if (abuseCheck.retryAfter) {
        headers['Retry-After'] = String(abuseCheck.retryAfter);
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify({ error: abuseCheck.message, reason: abuseCheck.reason }));
      return;
    }

    const derivative = getAuthorizedDerivative(imageId, requestedSize);
    if (!derivative) {
      res.writeHead(404, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(JSON.stringify({ error: 'Photo not found' }));
      return;
    }

    // Conditional HTTP ETag caching: return 304 Not Modified if client already has this version
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === derivative.etag) {
      res.writeHead(304, {
        'ETag': derivative.etag,
        'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      });
      res.end();
      return;
    }

    recordForensicEvent({
      action: 'DELIVER_AUTHORIZED_PHOTO',
      sid: verification.session.sid,
      ip: clientIp,
      resource: imageId,
      detail: `size=${requestedSize}&bytes=${derivative.length}`,
    });

    res.writeHead(200, {
      'Content-Type': derivative.contentType,
      'Content-Length': String(derivative.length),
      'ETag': derivative.etag,
      'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Content-Disposition': 'inline',
    });
    res.end(derivative.buffer);
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
