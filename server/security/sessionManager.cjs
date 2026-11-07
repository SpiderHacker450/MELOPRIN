const crypto = require('crypto');

const { LIMITER_CONFIG } = require('./limiterConfig.cjs');

const fallbackDevSecret = crypto.randomBytes(32).toString('hex');

/**
 * Validates configured HMAC session secret on startup.
 * In production, refuses to start if missing or shorter than 32 characters.
 */
function validateProductionSessionSecret() {
  if (process.env.NODE_ENV === 'production') {
    const envSecret = process.env.PINKVERSE_SESSION_SECRET;
    if (!envSecret || typeof envSecret !== 'string') {
      const msg = '[FATAL SECURITY CONFIG] PINKVERSE_SESSION_SECRET environment variable is required in production.';
      console.error(msg);
      throw new Error(msg);
    }
    if (envSecret.length < 32) {
      const msg = `[FATAL SECURITY CONFIG] In production, PINKVERSE_SESSION_SECRET must be at least 32 characters (provided: ${envSecret.length}).`;
      console.error(msg);
      throw new Error(msg);
    }
  }
}

function getSessionSecret() {
  const envSecret = process.env.PINKVERSE_SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') {
    validateProductionSessionSecret();
    return envSecret;
  }
  return envSecret || fallbackDevSecret;
}

// Default session lifespan: 4 hours (with automatic silent renewal)
const DEFAULT_SESSION_LIFESPAN_MS = 4 * 60 * 60 * 1000;

// Active in-memory session registry: sessionId -> sessionRecord
const activeSessions = new Map();

// Single-use tickets registry: ticketString -> { sid, imageId, exp, consumed: boolean }
const singleUseTickets = new Map();

// Periodically clean expired tickets and sessions every 2 minutes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ticket, record] of singleUseTickets.entries()) {
    if (now > record.exp || record.consumed) {
      singleUseTickets.delete(ticket);
    }
  }
  for (const [sid, session] of activeSessions.entries()) {
    if (now > session.exp || session.revoked) {
      activeSessions.delete(sid);
    }
  }
}, 2 * 60 * 1000);

// Unref background cleanup timer so it does not prevent Node.js from exiting cleanly
if (cleanupInterval && typeof cleanupInterval.unref === 'function') {
  cleanupInterval.unref();
}

/**
 * Creates an authorized session record and returns the signed cookie token.
 * Generates a per-session 256-bit AES key used for tile payload encryption.
 */
function createAuthorizedSession(clientIp = 'unknown') {
  const now = Date.now();
  const exp = now + DEFAULT_SESSION_LIFESPAN_MS;
  const sid = crypto.randomUUID();

  // 256-bit random AES key unique to this session
  const sessionKey = crypto.randomBytes(32).toString('hex');

  const sessionRecord = {
    sid,
    role: 'authorized_guest',
    iat: now,
    exp,
    sessionKey,
    clientIp,
    revoked: false,
    revokeReason: null,
    requestCount: 0,
    burstCount: 0,
    lastRequestTime: now,
    recentPhotoHistory: [],
    tokens: LIMITER_CONFIG.BUCKET_CAPACITY,
    lastRefill: now,
    consecutive429Count: 0,
  };

  activeSessions.set(sid, sessionRecord);

  // Signed token for cookie / header: base64(payload) + '.' + HMAC
  const publicPayload = {
    sid,
    role: 'authorized_guest',
    iat: now,
    exp,
  };

  const payloadBase64 = Buffer.from(JSON.stringify(publicPayload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payloadBase64)
    .digest('base64url');

  const token = `${payloadBase64}.${signature}`;

  return {
    token,
    sid,
    expiresAt: exp,
    sessionKey, // Returned once upon unlock so client can initialize Web Crypto decryption
  };
}

/**
 * Validates session token from request headers or cookies.
 */
function verifySession(tokenOrReq) {
  let token = null;

  if (typeof tokenOrReq === 'string') {
    token = tokenOrReq;
  } else if (tokenOrReq && typeof tokenOrReq === 'object') {
    // 1. Authorization: Bearer <token>
    const authHeader = tokenOrReq.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }

    // 2. Cookie: pinkverse_secure_session=<token>
    if (!token && tokenOrReq.headers?.cookie) {
      const match = tokenOrReq.headers.cookie.match(/pinkverse_secure_session=([^;]+)/);
      if (match) {
        token = decodeURIComponent(match[1].trim());
      }
    }

    // 3. Query param ?token=<token>
    if (!token && tokenOrReq.url) {
      try {
        const parsedUrl = new URL(tokenOrReq.url, 'http://localhost');
        const qToken = parsedUrl.searchParams.get('token');
        if (qToken) token = qToken.trim();
      } catch {}
    }
  }

  if (!token) {
    return {
      valid: false,
      reason: 'MISSING_TOKEN',
      message: 'Unauthorized',
    };
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return {
      valid: false,
      reason: 'MALFORMED_TOKEN',
      message: 'Unauthorized',
    };
  }

  const [payloadBase64, signature] = parts;

  // Constant-time signature verification
  const expectedSignature = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payloadBase64)
    .digest('base64url');

  const sigBuffer = Buffer.from(signature);
  const expectedSigBuffer = Buffer.from(expectedSignature);

  if (
    sigBuffer.length !== expectedSigBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedSigBuffer)
  ) {
    return {
      valid: false,
      reason: 'INVALID_SIGNATURE',
      message: 'Unauthorized',
    };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8'));
  } catch {
    return {
      valid: false,
      reason: 'MALFORMED_PAYLOAD',
      message: 'Unauthorized',
    };
  }

  const now = Date.now();
  if (payload.exp && now > payload.exp) {
    return {
      valid: false,
      reason: 'EXPIRED',
      message: 'Unauthorized: Session expired',
      expiredAt: payload.exp,
    };
  }

  // Retrieve or reconstruct session record across backend restarts
  let sessionRecord = activeSessions.get(payload.sid);
  if (!sessionRecord) {
    // Cryptographic HMAC signature was verified above; restore session record across backend process restarts
    sessionRecord = {
      sid: payload.sid,
      role: payload.role || 'authorized_guest',
      iat: payload.iat || now,
      exp: payload.exp,
      sessionKey: null,
      clientIp: null,
      revoked: false,
      revokeReason: null,
      requestCount: 0,
      burstCount: 0,
      lastRequestTime: now,
      recentPhotoHistory: [],
      tokens: LIMITER_CONFIG.BUCKET_CAPACITY,
      lastRefill: now,
      consecutive429Count: 0,
    };
    activeSessions.set(payload.sid, sessionRecord);
  }

  if (sessionRecord.revoked) {
    return {
      valid: false,
      reason: 'SESSION_REVOKED',
      message: `Unauthorized: ${sessionRecord.revokeReason || 'Session revoked'}`,
    };
  }

  return {
    valid: true,
    session: sessionRecord,
  };
}

/**
 * Revokes a session immediately (used by abuse defender).
 */
function revokeSession(sid, reason = 'Abuse detected') {
  const session = activeSessions.get(sid);
  if (session) {
    session.revoked = true;
    session.revokeReason = reason;
    console.warn(`[SECURITY ALERT] Session ${sid} REVOKED. Reason: ${reason}`);
    return true;
  }
  return false;
}

/**
 * Issues a single-use signed ticket for fetching an encrypted tile payload.
 * Valid for <= 60 seconds and tied to session and image ID.
 */
function createSingleUseTicket(sid, imageId) {
  const exp = Date.now() + 60 * 1000; // 60s lifespan
  const salt = crypto.randomBytes(8).toString('hex');
  const payload = `${sid}:${imageId}:${exp}:${salt}`;

  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payload)
    .digest('base64url');

  const ticket = `${Buffer.from(payload).toString('base64url')}.${sig}`;

  singleUseTickets.set(ticket, {
    sid,
    imageId,
    exp,
    consumed: false,
  });

  return {
    ticket,
    expiresAt: exp,
  };
}

/**
 * Validates and consumes a single-use ticket.
 * Replaying fails immediately.
 */
function consumeSingleUseTicket(ticket, expectedSid, expectedImageId) {
  if (!ticket || typeof ticket !== 'string') {
    return { valid: false, reason: 'MISSING_TICKET' };
  }

  const record = singleUseTickets.get(ticket);
  if (!record) {
    return { valid: false, reason: 'TICKET_NOT_FOUND_OR_EXPIRED' };
  }

  if (record.consumed) {
    return { valid: false, reason: 'TICKET_ALREADY_CONSUMED' };
  }

  if (Date.now() > record.exp) {
    singleUseTickets.delete(ticket);
    return { valid: false, reason: 'TICKET_EXPIRED' };
  }

  if (record.sid !== expectedSid || record.imageId !== expectedImageId) {
    return { valid: false, reason: 'TICKET_MISMATCH' };
  }

  // Consume ticket immediately (Single Use)
  record.consumed = true;
  singleUseTickets.delete(ticket);

  return { valid: true };
}

/**
 * Checks if a session is near expiration (< 1 hour remaining) and renews it silently.
 */
function renewSessionIfNearExpiry(sessionRecord) {
  const now = Date.now();
  if (!sessionRecord || sessionRecord.revoked) return null;
  if (sessionRecord.exp - now < 60 * 60 * 1000) {
    sessionRecord.exp = now + DEFAULT_SESSION_LIFESPAN_MS;
    const publicPayload = {
      sid: sessionRecord.sid,
      role: sessionRecord.role || 'authorized_guest',
      iat: sessionRecord.iat,
      exp: sessionRecord.exp,
    };
    const payloadBase64 = Buffer.from(JSON.stringify(publicPayload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', getSessionSecret())
      .update(payloadBase64)
      .digest('base64url');
    const token = `${payloadBase64}.${signature}`;
    return { token, expiresAt: sessionRecord.exp };
  }
  return null;
}

module.exports = {
  createAuthorizedSession,
  verifySession,
  revokeSession,
  createSingleUseTicket,
  consumeSingleUseTicket,
  renewSessionIfNearExpiry,
  validateProductionSessionSecret,
  getSessionSecret,
  activeSessions,
};
