const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT_DIR = path.join(__dirname, '..', '..');
const PRIVATE_STORAGE_DIR = path.join(ROOT_DIR, 'storage', 'private_photos');
const THUMBNAILS_DIR = path.join(PRIVATE_STORAGE_DIR, 'thumbnails');
const VIEWING_DIR = path.join(PRIVATE_STORAGE_DIR, 'viewing_derivatives');
const OLD_DERIVATIVES_DIR = path.join(PRIVATE_STORAGE_DIR, 'derivatives');
const MANIFEST_PATH = path.join(PRIVATE_STORAGE_DIR, 'manifest.server.json');

let serverManifest = null;

function loadManifest() {
  if (!serverManifest) {
    if (fs.existsSync(MANIFEST_PATH)) {
      serverManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    } else {
      serverManifest = {};
    }
  }
  return serverManifest;
}

// In-memory cache for pre-loaded derivative buffers and computed ETags
// Key: `${imageId}:${size}` -> { buffer, etag, length }
const derivativeCache = new Map();

/**
 * Resolves an authenticated derivative for a private photograph.
 * Validates identifier, prevents directory traversal, checks cache, and returns buffer with strong ETag.
 */
function getAuthorizedDerivative(imageId, size = 'thumb') {
  // 1. Strict validation: prevent directory traversal or malformed IDs
  if (!imageId || typeof imageId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(imageId)) {
    return null;
  }

  const isThumb = size === 'thumb' || size === 'small';
  const tier = isThumb ? 'thumb' : 'large';
  const cacheKey = `${imageId}:${tier}`;

  if (derivativeCache.has(cacheKey)) {
    return derivativeCache.get(cacheKey);
  }

  // 2. Resolve file path
  let filePath = isThumb
    ? path.join(THUMBNAILS_DIR, `${imageId}.webp`)
    : path.join(VIEWING_DIR, `${imageId}.webp`);

  if (!fs.existsSync(filePath)) {
    // Check fallback in viewing or thumbnails
    filePath = isThumb
      ? path.join(VIEWING_DIR, `${imageId}.webp`)
      : path.join(THUMBNAILS_DIR, `${imageId}.webp`);
  }

  // Fallback to legacy derivatives if present
  if (!fs.existsSync(filePath)) {
    const manifest = loadManifest();
    const entry = manifest[imageId];
    if (entry && entry.internalId) {
      const padded = String(entry.internalId).padStart(2, '0');
      const widthStr = isThumb ? '480' : '1600';
      filePath = path.join(OLD_DERIVATIVES_DIR, `pv-${padded}-${widthStr}.webp`);
    }
  }

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const buffer = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
    const etag = `W/"pv-${tier}-${buffer.length}-${hash}"`;

    const result = {
      buffer,
      etag,
      length: buffer.length,
      contentType: 'image/webp',
    };

    derivativeCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[ImageDelivery] Read error for ${imageId}:`, err.message);
    return null;
  }
}

/**
 * Resolves an authenticated request for a private photograph (legacy format).
 */
async function resolvePrivateImage(imageId, size = 'medium') {
  const isThumb = size === 'thumb' || size === 'small';
  const tier = isThumb ? 'thumb' : 'large';
  const item = getAuthorizedDerivative(imageId, tier);

  if (!item) {
    return {
      status: 404,
      error: 'Private photograph not found.',
    };
  }

  return {
    status: 200,
    buffer: item.buffer,
    contentType: 'image/webp',
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(item.length),
      'ETag': item.etag,
      'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
    },
  };
}

module.exports = {
  getAuthorizedDerivative,
  resolvePrivateImage,
};
