/**
 * Time-Locked Release Middleware
 * 
 * Strict enforcement of the 2026-11-20T18:30:00Z release policy.
 * - Uniform byte-identical HTTP 423 on all protected endpoints prior to release.
 * - Rate-limited status, unlock, and content endpoints.
 * - Denies GET, HEAD, OPTIONS, Range, and WebSocket attempts before release.
 * - Zero timing or existence oracle.
 * - Validated client IP extraction with trust-proxy protection.
 */

const {
  getReleaseStatus,
  isReleased,
  UNIFORM_LOCKED_PAYLOAD,
} = require('./releasePolicy.cjs');
const { getPrivateExperience } = require('./privateContentService.cjs');
const {
  createAuthorizedSession,
  verifySession,
  renewSessionIfNearExpiry,
} = require('./sessionManager.cjs');
const {
  checkStatusRateLimit,
  checkReleaseRateLimit,
  checkPhotoRateLimit,
} = require('./releaseRateLimiter.cjs');
const { getClientIp } = require('./trustProxy.cjs');

function sendUniformLocked(res, req) {
  res.writeHead(423, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': UNIFORM_LOCKED_PAYLOAD.length,
    'Cache-Control': 'private, no-store, max-age=0',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });

  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(UNIFORM_LOCKED_PAYLOAD);
  }
}

function releaseMiddleware(req, res, next) {
  const clientIp = getClientIp(req);
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // Global Hardened Security Headers on all responses
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

  // Test clock injection ONLY permitted in test environment (NODE_ENV === 'test')
  const testClock = (process.env.NODE_ENV === 'test')
    ? (req.headers['x-test-clock'] || req.__testClock || null)
    : null;

  // 1. Release Status Endpoint: GET /api/release/status (with targeted CORS for GitHub Pages)
  if (pathname === '/api/release/status') {
    const origin = req.headers.origin;
    const ALLOWED_ORIGINS = [
      'https://spiderhacker450.github.io',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ];

    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control');
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    // Dedicated rate limit check for status polling
    const rateCheck = checkStatusRateLimit(clientIp);
    if (!rateCheck.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(rateCheck.retryAfterSeconds || 60),
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'TOO_MANY_REQUESTS' }));
      return;
    }

    const status = getReleaseStatus(testClock);
    const body = Buffer.from(JSON.stringify(status), 'utf8');

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store, max-age=0',
      'Pragma': 'no-cache',
    });
    res.end(body);
    return;
  }

  // 2. Identify if route is protected by the release gate
  const isPhotoPath = pathname.startsWith('/api/v2/photos') || pathname.startsWith('/api/photos');
  const isProtectedPath =
    pathname === '/api/release/content' ||
    pathname.startsWith('/api/release/experience') ||
    isPhotoPath ||
    pathname.startsWith('/photos') ||
    pathname.startsWith('/memories') ||
    pathname.startsWith('/storage');

  if (isProtectedPath) {
    // Dedicated rate limiting: high-throughput for photos, standard for protected endpoints
    const rateCheck = isPhotoPath
      ? checkPhotoRateLimit(clientIp)
      : checkReleaseRateLimit(clientIp);

    if (!rateCheck.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(rateCheck.retryAfterSeconds || 60),
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      });
      res.end(JSON.stringify({
        error: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded. Please wait before retrying.',
      }));
      return;
    }

    // Check release status using host clock (or testClock in test mode)
    const released = isReleased(testClock);

    if (!released) {
      // Prior to release: Uniform HTTP 423 Locked for ALL protected endpoints
      sendUniformLocked(res, req);
      return;
    }

    // After release: Handle private content delivery endpoint
    // Automatically issues an HMAC-signed session cookie on the first request (no passcode needed)
    if (pathname === '/api/release/content' && req.method === 'GET') {
      try {
        const experience = getPrivateExperience(testClock);
        let sessionCookieHeader = null;

        const verification = verifySession(req);
        if (!verification.valid) {
          // Automatic session issuance for legitimate visitor without passcode
          const newSession = createAuthorizedSession(clientIp);
          const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.connection?.encrypted || req.socket?.encrypted;
          sessionCookieHeader = `pinkverse_secure_session=${newSession.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=14400${isSecure ? '; Secure' : ''}`;
        } else if (verification.session) {
          // Silent renewal if less than 1 hour remaining on existing session
          const renewed = renewSessionIfNearExpiry(verification.session);
          if (renewed) {
            const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.connection?.encrypted || req.socket?.encrypted;
            sessionCookieHeader = `pinkverse_secure_session=${renewed.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=14400${isSecure ? '; Secure' : ''}`;
          }
        }

        const body = Buffer.from(JSON.stringify(experience), 'utf8');
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
          'Referrer-Policy': 'no-referrer',
        };
        if (sessionCookieHeader) {
          headers['Set-Cookie'] = sessionCookieHeader;
        }

        res.writeHead(200, headers);
        res.end(body);
        return;
      } catch (err) {
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
        });
        res.end(JSON.stringify({ error: 'FAILED_TO_LOAD_CONTENT' }));
        return;
      }
    }
  }

  // Forward to next handler
  next();
}

module.exports = {
  releaseMiddleware,
  sendUniformLocked,
};
