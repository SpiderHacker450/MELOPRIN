const path = require('path');
const fs = require('fs');

const ROOT_DIR = path.join(__dirname, '..', '..');
const PRIVATE_STORAGE_DIR = path.join(ROOT_DIR, 'storage', 'private_photos');
const DERIVATIVES_DIR = path.join(PRIVATE_STORAGE_DIR, 'derivatives');
const MANIFEST_PATH = path.join(PRIVATE_STORAGE_DIR, 'manifest.server.json');

let serverManifest = null;

function loadManifest() {
  if (!serverManifest) {
    if (!fs.existsSync(MANIFEST_PATH)) {
      throw new Error(`Server manifest not found at ${MANIFEST_PATH}`);
    }
    serverManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  }
  return serverManifest;
}

/**
 * Resolves an authenticated request for a private photograph.
 * Validates identifier, prevents directory traversal, and returns clean image buffer.
 */
async function resolvePrivateImage(imageId, size = 'medium') {
  // 1. Strict validation: prevent directory traversal or malformed IDs
  if (!imageId || typeof imageId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(imageId)) {
    return {
      status: 404,
      error: 'Invalid or missing image identifier.',
    };
  }

  // 2. Load manifest
  const manifest = loadManifest();
  const entry = manifest[imageId];

  if (!entry) {
    return {
      status: 404,
      error: 'Private photograph not found.',
    };
  }

  // 3. Resolve derivative size
  const padded = String(entry.internalId).padStart(2, '0');
  const sizeMap = {
    small: '480',
    medium: '960',
    large: '1600',
  };
  const widthStr = sizeMap[size] || '960';
  const derivativeFilename = `pv-${padded}-${widthStr}.webp`;
  const derivativePath = path.join(DERIVATIVES_DIR, derivativeFilename);

  if (!fs.existsSync(derivativePath)) {
    return {
      status: 404,
      error: 'Image derivative not available.',
    };
  }

  // 4. Fetch clean viewing derivative without any watermark
  try {
    const buffer = fs.readFileSync(derivativePath);
    return {
      status: 200,
      buffer,
      contentType: 'image/webp',
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      },
    };
  } catch (err) {
    console.error('[ImageDelivery] Read error:', err);
    return {
      status: 500,
      error: 'Internal image processing error.',
    };
  }
}

module.exports = {
  resolvePrivateImage,
};
