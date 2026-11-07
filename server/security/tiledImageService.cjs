const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const ROOT_DIR = path.join(__dirname, '..', '..');
const PRIVATE_STORAGE_DIR = path.join(ROOT_DIR, 'storage', 'private_photos');
const VIEWING_DERIVATIVES_DIR = path.join(PRIVATE_STORAGE_DIR, 'viewing_derivatives');
const MEDIUM_DIR = path.join(PRIVATE_STORAGE_DIR, 'medium');
const THUMBNAILS_DIR = path.join(PRIVATE_STORAGE_DIR, 'thumbnails');
const MANIFEST_PATH = path.join(PRIVATE_STORAGE_DIR, 'manifest.server.json');

let serverManifest = null;

function loadManifest() {
  if (!serverManifest) {
    serverManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  }
  return serverManifest;
}

// In-memory caches for raw unencrypted tier data: imageId -> { imageId, width, height, data }
const thumbnailCache = new Map();
const mediumCache = new Map();
const largeCache = new Map();

/**
 * Loads pre-generated ~400px thumbnail from disk once and caches in memory.
 */
function getThumbnailData(imageId) {
  if (thumbnailCache.has(imageId)) {
    return thumbnailCache.get(imageId);
  }

  const manifest = loadManifest();
  const entry = manifest[imageId];
  if (!entry) return null;

  const thumbFile = entry.thumbnailFile || `${imageId}.webp`;
  const thumbPath = path.join(THUMBNAILS_DIR, thumbFile);
  if (!fs.existsSync(thumbPath)) return null;

  const thumbBuf = fs.readFileSync(thumbPath);
  const thumbData = {
    imageId,
    width: entry.thumbWidth || 400,
    height: entry.thumbHeight || 300,
    data: thumbBuf.toString('base64'),
  };

  thumbnailCache.set(imageId, thumbData);
  return thumbData;
}

/**
 * Loads pre-generated ~800px medium derivative from disk once and caches in memory.
 */
function getMediumData(imageId) {
  if (mediumCache.has(imageId)) {
    return mediumCache.get(imageId);
  }

  const manifest = loadManifest();
  const entry = manifest[imageId];
  if (!entry) return null;

  const medFile = entry.mediumFile || `${imageId}.webp`;
  const medPath = path.join(MEDIUM_DIR, medFile);
  if (!fs.existsSync(medPath)) return null;

  const medBuf = fs.readFileSync(medPath);
  const medData = {
    imageId,
    width: entry.mediumWidth || 800,
    height: entry.mediumHeight || 600,
    data: medBuf.toString('base64'),
  };

  mediumCache.set(imageId, medData);
  return medData;
}

/**
 * Loads pre-generated ~1600px high-resolution viewing derivative from disk once and caches in memory.
 */
function getLargeData(imageId) {
  if (largeCache.has(imageId)) {
    return largeCache.get(imageId);
  }

  const manifest = loadManifest();
  const entry = manifest[imageId];
  if (!entry) return null;

  const largeFile = entry.derivativeFile || `${imageId}.webp`;
  const largePath = path.join(VIEWING_DERIVATIVES_DIR, largeFile);
  if (!fs.existsSync(largePath)) return null;

  const largeBuf = fs.readFileSync(largePath);
  const largeData = {
    imageId,
    width: entry.width || 1600,
    height: entry.height || 1200,
    data: largeBuf.toString('base64'),
  };

  largeCache.set(imageId, largeData);
  return largeData;
}

/**
 * Encrypts photographic package using AES-256-GCM.
 * Delivers single-piece high-fidelity image for each tier:
 * - 'thumb' (400px Q70 Lanczos3)
 * - 'medium' (800px Q78 Lanczos3)
 * - 'large' (1600px Q84 Lanczos3)
 * Output: Buffer of [12 bytes IV] + [16 bytes GCM Auth Tag] + [AES-256-GCM Ciphertext]
 */
const INVISIBLE_WATERMARK = process.env.INVISIBLE_WATERMARK === 'true'; // default OFF

async function generateEncryptedTilePackage(imageId, session, requestedSize = 'large') {
  const forensicFingerprint = INVISIBLE_WATERMARK
    ? {
        sid: session.sid.substring(0, 12),
        ts: Date.now(),
        h: crypto
          .createHmac('sha256', session.sessionKey)
          .update(`${session.sid}:${session.clientIp}`)
          .digest('hex')
          .substring(0, 16),
      }
    : undefined;

  let itemData = null;
  const isThumb = requestedSize === 'thumb' || requestedSize === 'small';
  const isMedium = requestedSize === 'medium';

  if (isThumb) {
    itemData = getThumbnailData(imageId);
  } else if (isMedium) {
    itemData = getMediumData(imageId);
  } else {
    itemData = getLargeData(imageId);
  }

  // Fallback to other available tiers if missing
  if (!itemData) {
    itemData = getLargeData(imageId) || getMediumData(imageId) || getThumbnailData(imageId);
  }
  if (!itemData) return null;

  const payloadObject = {
    v: 3,
    imageId,
    size: requestedSize,
    isThumb,
    isMedium,
    isLarge: !isThumb && !isMedium,
    width: itemData.width,
    height: itemData.height,
    cols: 1,
    rows: 1,
    tiles: [
      {
        origIndex: 0,
        col: 0,
        row: 0,
        x: 0,
        y: 0,
        w: itemData.width,
        h: itemData.height,
        data: itemData.data,
      },
    ],
    ...(forensicFingerprint ? { fp: forensicFingerprint } : {}),
  };

  const payloadBuffer = Buffer.from(JSON.stringify(payloadObject), 'utf8');
  const keyBuffer = Buffer.from(session.sessionKey, 'hex');
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(payloadBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]);
}

module.exports = {
  generateEncryptedTilePackage,
};

