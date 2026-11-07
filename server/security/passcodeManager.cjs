const crypto = require('crypto');

/**
 * Validates configured passcode on startup.
 * In production, refuses to start if missing or shorter than 12 characters.
 */
function validateProductionPasscode() {
  const passcode = process.env.PINKVERSE_PASSCODE;
  if (process.env.NODE_ENV === 'production') {
    if (!passcode || typeof passcode !== 'string') {
      const msg = '[FATAL SECURITY CONFIG] PINKVERSE_PASSCODE environment variable is required in production.';
      console.error(msg);
      throw new Error(msg);
    }
    if (passcode.length < 12) {
      const msg = `[FATAL SECURITY CONFIG] In production, PINKVERSE_PASSCODE must be at least 12 characters (provided: ${passcode.length}).`;
      console.error(msg);
      throw new Error(msg);
    }
  }
}

// Lockout configuration: 5 failed attempts within 15 minutes -> 15 min lockout per IP
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

// Per-IP isolated attempt tracking store
const ipAttemptStore = new Map();

function checkPasscode(inputPasscode, clientIp = '127.0.0.1') {
  const now = Date.now();
  const configuredPasscode = process.env.PINKVERSE_PASSCODE;

  // Fail closed if passcode is unconfigured
  if (!configuredPasscode) {
    return {
      success: false,
      reason: 'NOT_CONFIGURED',
      message: 'Authentication is currently disabled.',
    };
  }

  // 1. Site Expiry Check
  const siteExpiry = process.env.PINKVERSE_SITE_EXPIRY;
  if (siteExpiry) {
    const expiryTime = new Date(siteExpiry).getTime();
    if (!isNaN(expiryTime) && now > expiryTime) {
      return {
        success: false,
        reason: 'SITE_EXPIRED',
        message: 'This celebration has expired.',
      };
    }
  }

  // 2. Per-IP Lockout & Rate-Limit Check
  let record = ipAttemptStore.get(clientIp);
  if (!record || now > record.resetAt) {
    record = { count: 0, resetAt: now + WINDOW_MS, lockedUntil: 0 };
    ipAttemptStore.set(clientIp, record);
  }

  if (record.lockedUntil > now) {
    const remainingSecs = Math.ceil((record.lockedUntil - now) / 1000);
    return {
      success: false,
      reason: 'LOCKED_OUT',
      message: `Too many failed attempts. Try again in ${remainingSecs} seconds.`,
      retryAfterSeconds: remainingSecs,
    };
  }

  // 3. Constant-Time Passcode Verification
  const inputBuffer = crypto
    .createHash('sha256')
    .update(String(inputPasscode || ''))
    .digest();

  const targetBuffer = crypto
    .createHash('sha256')
    .update(String(configuredPasscode))
    .digest();

  const isMatch = crypto.timingSafeEqual(inputBuffer, targetBuffer);

  if (isMatch) {
    // Reset failed counter upon successful unlock for this IP
    ipAttemptStore.delete(clientIp);
    return {
      success: true,
      message: 'Access granted.',
    };
  }

  // Record failure for this IP
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_MS;
    const remainingSecs = Math.ceil(LOCKOUT_MS / 1000);
    return {
      success: false,
      reason: 'LOCKED_OUT',
      message: `Too many failed attempts. Locked out for ${remainingSecs} seconds.`,
      retryAfterSeconds: remainingSecs,
    };
  }

  return {
    success: false,
    reason: 'INVALID_PASSCODE',
    message: 'Incorrect passcode.',
    remainingAttempts: MAX_ATTEMPTS - record.count,
  };
}

module.exports = {
  checkPasscode,
  validateProductionPasscode,
};
