const { revokeSession } = require('./sessionManager.cjs');
const { recordForensicEvent } = require('./forensicsLog.cjs');
const { LIMITER_CONFIG, IS_DEV } = require('./limiterConfig.cjs');

// In-memory IP tracking: ip -> { count: number, windowStart: number }
const ipLimits = new Map();

/**
 * Checks client request headers for obvious malicious scraping agents.
 */
function isSuspiciousClient(req) {
  const ua = req.headers['user-agent'] || '';
  const scraperPatterns = [
    /python-requests/i,
    /curl\//i,
    /wget\//i,
    /scrapy/i,
    /httpclient/i,
    /aiohttp/i,
    /go-http-client/i,
  ];

  for (const pattern of scraperPatterns) {
    if (pattern.test(ua)) {
      return { suspicious: true, reason: `Scraper User-Agent: ${ua}` };
    }
  }

  return { suspicious: false };
}

/**
 * Evaluates request pattern using a token bucket rate limiter per session.
 * - Burst allowance: BUCKET_CAPACITY (~30-40, relaxed in dev).
 * - Refill rate: REFILL_RATE_PER_SEC (~10-12/s).
 * - Thumbnail discount: 0.5 tokens vs 1.0 token for large photos.
 * - On rate limit: returns HTTP 429 + Retry-After (NEVER revokes normal sessions on burst!).
 * - Revokes session ONLY for sustained abuse or an obvious sequential scraping pattern.
 */
function evaluateRequestAbuse(session, clientIp, requestedImageId, requestedSize = 'large') {
  const now = Date.now();

  // 1. Global IP Rate Limiting (Prevents multi-session IP flood)
  let ipRecord = ipLimits.get(clientIp);
  if (!ipRecord || now - ipRecord.windowStart > 60000) {
    ipRecord = { count: 1, windowStart: now };
    ipLimits.set(clientIp, ipRecord);
  } else {
    ipRecord.count += 1;
    if (ipRecord.count > LIMITER_CONFIG.MAX_REQUESTS_PER_MINUTE_PER_IP) {
      recordForensicEvent({
        action: 'RATE_LIMIT_BLOCK',
        sid: session?.sid,
        ip: clientIp,
        resource: requestedImageId,
        detail: `Exceeded ${LIMITER_CONFIG.MAX_REQUESTS_PER_MINUTE_PER_IP} req/min for IP`,
      });
      return {
        allowed: false,
        status: 429,
        reason: 'IP_RATE_LIMITED',
        retryAfter: 2,
        message: 'Too many requests from this IP. Please wait a moment.',
      };
    }
  }

  // 2. Session-level Token Bucket & Abuse Evaluation
  if (session) {
    session.requestCount = (session.requestCount || 0) + 1;

    // A. Detect Automated Rapid Sequential Scraping (Full photo extraction)
    if (requestedImageId && requestedSize !== 'thumb') {
      if (!session.recentPhotoHistory) session.recentPhotoHistory = [];
      const history = session.recentPhotoHistory;
      history.push({ id: requestedImageId, time: now });
      if (history.length > 30) history.shift();

      if (history.length >= LIMITER_CONFIG.SCRAPING_THRESHOLD_COUNT) {
        const recent = history.slice(-LIMITER_CONFIG.SCRAPING_THRESHOLD_COUNT);
        const timeDelta = recent[recent.length - 1].time - recent[0].time;
        const uniqueIds = new Set(recent.map((r) => r.id));

        // If requesting 18+ different photos sequentially in < 1.5s
        if (
          uniqueIds.size >= LIMITER_CONFIG.SCRAPING_THRESHOLD_COUNT &&
          timeDelta < LIMITER_CONFIG.SCRAPING_WINDOW_MS
        ) {
          revokeSession(session.sid, 'Automated rapid scraping detected');
          recordForensicEvent({
            action: 'SESSION_REVOKED',
            sid: session.sid,
            ip: clientIp,
            resource: requestedImageId,
            detail: `Rapid sequential scraping: ${uniqueIds.size} photos in ${timeDelta}ms`,
          });
          return {
            allowed: false,
            status: 403,
            reason: 'SESSION_REVOKED_SCRAPING',
            message: 'Session revoked due to automated scraping pattern.',
          };
        }
      }
    }

    // B. Token Bucket Rate Limiter
    if (session.tokens === undefined) {
      session.tokens = LIMITER_CONFIG.BUCKET_CAPACITY;
      session.lastRefill = now;
      session.consecutive429Count = 0;
    }

    // Refill tokens based on elapsed time
    const elapsedSec = Math.max(0, (now - session.lastRefill) / 1000);
    session.tokens = Math.min(
      LIMITER_CONFIG.BUCKET_CAPACITY,
      session.tokens + elapsedSec * LIMITER_CONFIG.REFILL_RATE_PER_SEC
    );
    session.lastRefill = now;

    // Determine request cost (thumbnail discount)
    const cost = LIMITER_CONFIG.TOKEN_COST[requestedSize] || 1.0;

    if (session.tokens >= cost) {
      session.tokens -= cost;
      session.consecutive429Count = 0;
      session.lastRequestTime = now;
      return { allowed: true };
    }

    // Rate limit hit (Tokens depleted)
    session.consecutive429Count = (session.consecutive429Count || 0) + 1;

    // Check for sustained abuse: client hitting rate limit 8+ times consecutively without backing off
    if (session.consecutive429Count > LIMITER_CONFIG.MAX_CONSECUTIVE_429_VIOLATIONS) {
      revokeSession(session.sid, 'Sustained rate limit abuse');
      recordForensicEvent({
        action: 'SESSION_REVOKED',
        sid: session.sid,
        ip: clientIp,
        resource: requestedImageId,
        detail: 'Sustained rate limit abuse without backoff',
      });
      return {
        allowed: false,
        status: 403,
        reason: 'SESSION_REVOKED_SUSTAINED',
        message: 'Session revoked due to sustained abuse.',
      };
    }

    // Normal rate limiting: Return HTTP 429 + Retry-After (DO NOT REVOKE SESSION)
    recordForensicEvent({
      action: 'RATE_LIMIT_429',
      sid: session.sid,
      ip: clientIp,
      resource: requestedImageId,
      detail: `Tokens depleted (${session.tokens.toFixed(1)} < ${cost})`,
    });

    return {
      allowed: false,
      status: 429,
      reason: 'RATE_LIMITED',
      retryAfter: LIMITER_CONFIG.RETRY_AFTER_SECONDS,
      message: 'Rate limit reached. Please wait and retry.',
    };
  }

  return { allowed: true };
}

module.exports = {
  isSuspiciousClient,
  evaluateRequestAbuse,
};
