/**
 * Trust-Proxy & Client IP Evaluator
 * 
 * Prevents IP spoofing via X-Forwarded-For headers when direct socket connections are used.
 * Configured via process.env.TRUST_PROXY:
 *   - 'false' / unset: Direct connection. Ignores all forwarding headers, uses req.socket.remoteAddress.
 *   - 'true' / '1' / 'loopback': Reverse proxy mode. Parses X-Forwarded-For safely.
 *   - 'cloudflare': Prioritizes CF-Connecting-IP header.
 */

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function getClientIp(req) {
  const socketIp = req.socket?.remoteAddress || '127.0.0.1';
  const trustProxyConfig = (process.env.TRUST_PROXY || 'false').toLowerCase().trim();

  // If trust proxy is disabled, strictly use socket IP
  if (trustProxyConfig === 'false' || trustProxyConfig === '0') {
    return normalizeIp(socketIp);
  }

  // Cloudflare mode
  if (trustProxyConfig === 'cloudflare' && req.headers['cf-connecting-ip']) {
    return normalizeIp(req.headers['cf-connecting-ip']);
  }

  // Loopback mode: only trust forwarded headers if incoming socket connection is loopback
  if (trustProxyConfig === 'loopback' && !isLoopback(socketIp)) {
    return normalizeIp(socketIp);
  }

  // Proxy mode (true / 1 / loopback from local proxy)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = forwarded.split(',').map(s => s.trim()).filter(Boolean);
    if (ips.length > 0) {
      // First IP in standard chain is client IP
      return normalizeIp(ips[0]);
    }
  }

  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return normalizeIp(realIp);
  }

  return normalizeIp(socketIp);
}

function normalizeIp(ip) {
  if (!ip) return '127.0.0.1';
  let clean = String(ip).trim();
  if (clean.startsWith('::ffff:')) {
    clean = clean.slice(7);
  }
  return clean;
}

module.exports = {
  getClientIp,
  normalizeIp,
};

