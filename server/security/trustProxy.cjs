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
  if (!ip) return false;
  const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

function getClientIp(req) {
  const socketIp = req.socket?.remoteAddress || '127.0.0.1';
  const trustProxyConfig = (process.env.TRUST_PROXY || 'false').toLowerCase().trim();

  // If trust proxy is disabled, strictly use socket IP
  if (trustProxyConfig === 'false' || trustProxyConfig === '0') {
    return normalizeIp(socketIp);
  }

  // Security mandate: Only trust CF-Connecting-IP and forwarded headers if socket peer is loopback
  if (!isLoopback(socketIp)) {
    return normalizeIp(socketIp);
  }

  // When socket peer is loopback (e.g. cloudflared proxy):
  // 1. Prioritize Cloudflare client IP header
  if (req.headers['cf-connecting-ip']) {
    return normalizeIp(req.headers['cf-connecting-ip']);
  }

  // 2. Standard X-Forwarded-For chain
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = forwarded.split(',').map(s => s.trim()).filter(Boolean);
    if (ips.length > 0) {
      return normalizeIp(ips[0]);
    }
  }

  if (req.headers['x-real-ip']) {
    return normalizeIp(req.headers['x-real-ip']);
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

