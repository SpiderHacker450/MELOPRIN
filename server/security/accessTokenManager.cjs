const crypto = require('crypto');

/**
 * Validates configured access token on startup.
 * If PINKVERSE_ACCESS_TOKEN is set, it must be at least 24 characters.
 */
function validateProductionAccessToken() {
  const token = process.env.PINKVERSE_ACCESS_TOKEN;
  if (token && typeof token === 'string' && token.trim().length > 0) {
    if (token.trim().length < 24) {
      const msg = `[FATAL SECURITY CONFIG] If set, PINKVERSE_ACCESS_TOKEN must be at least 24 characters (provided: ${token.trim().length}).`;
      console.error(msg);
      throw new Error(msg);
    }
  }
}

/**
 * Verifies X-Access-Token header from incoming request against PINKVERSE_ACCESS_TOKEN.
 * - If PINKVERSE_ACCESS_TOKEN is NOT set or empty: access is open ({ required: false, valid: true }).
 * - If PINKVERSE_ACCESS_TOKEN IS set:
 *   - Missing header -> { required: true, valid: false, reason: 'MISSING_ACCESS_TOKEN' }
 *   - Constant-time timingSafeEqual comparison.
 *   - Mismatch -> { required: true, valid: false, reason: 'INVALID_ACCESS_TOKEN' }
 *   - Match -> { required: true, valid: true }
 */
function verifyAccessToken(req) {
  const envToken = process.env.PINKVERSE_ACCESS_TOKEN;
  if (!envToken || typeof envToken !== 'string' || envToken.trim().length === 0) {
    return { required: false, valid: true };
  }

  const clientToken = req.headers ? req.headers['x-access-token'] : null;
  if (!clientToken || typeof clientToken !== 'string' || clientToken.trim().length === 0) {
    return { required: true, valid: false, reason: 'MISSING_ACCESS_TOKEN' };
  }

  const clientBuf = Buffer.from(clientToken.trim(), 'utf8');
  const expectedBuf = Buffer.from(envToken.trim(), 'utf8');

  if (
    clientBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(clientBuf, expectedBuf)
  ) {
    return { required: true, valid: false, reason: 'INVALID_ACCESS_TOKEN' };
  }

  return { required: true, valid: true };
}

module.exports = {
  validateProductionAccessToken,
  verifyAccessToken,
};
