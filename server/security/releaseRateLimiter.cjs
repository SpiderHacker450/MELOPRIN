/**
 * Rate Limiter for Release and Authentication Endpoints
 * Prevents high-frequency scanning, brute force, and status polling flooding.
 */

const WINDOW_MS = 60 * 1000;

// Configurable limits
const STATUS_LIMIT = 30; // 30 req/min for status check
const PROTECTED_LIMIT = 30; // 30 req/min for protected gated endpoints
const PHOTO_LIMIT = 100; // 100 req/min for authorized photo browsing & gallery grids

const statusBuckets = new Map();
const protectedBuckets = new Map();
const photoBuckets = new Map();

function checkBucket(bucketMap, clientIp, maxRequests) {
  const now = Date.now();
  let bucket = bucketMap.get(clientIp);

  if (!bucket || now > bucket.resetTime) {
    bucket = { count: 0, resetTime: now + WINDOW_MS };
    bucketMap.set(clientIp, bucket);
  }

  bucket.count++;

  if (bucket.count > maxRequests) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((bucket.resetTime - now) / 1000),
    };
  }

  return { allowed: true };
}

function checkStatusRateLimit(clientIp) {
  return checkBucket(statusBuckets, clientIp, STATUS_LIMIT);
}

function checkReleaseRateLimit(clientIp) {
  return checkBucket(protectedBuckets, clientIp, PROTECTED_LIMIT);
}

function checkPhotoRateLimit(clientIp) {
  return checkBucket(photoBuckets, clientIp, PHOTO_LIMIT);
}

// Cleanup stale IP entries every 5 minutes (unref'd)
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const map of [statusBuckets, protectedBuckets, photoBuckets]) {
    for (const [ip, bucket] of map.entries()) {
      if (now > bucket.resetTime + WINDOW_MS) {
        map.delete(ip);
      }
    }
  }
}, 5 * 60 * 1000);

if (cleanupTimer && typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

module.exports = {
  checkStatusRateLimit,
  checkReleaseRateLimit,
  checkPhotoRateLimit,
};
