const fs = require('fs');
const path = require('path');
const { isReleased } = require('./releasePolicy.cjs');
const { encryptData, decryptData } = require('./contentEncryption.cjs');

const PRIVATE_STORAGE_DIR = path.join(__dirname, '..', '..', 'storage', 'private_content');
const ENCRYPTED_CONTENT_PATH = path.join(PRIVATE_STORAGE_DIR, 'experience.enc');

// In-memory cache for decrypted content (populated ONLY after release instant)
let decryptedCache = null;

/**
 * Stores raw content and photo metadata encrypted at rest.
 * Used during deployment or setup to ensure no plain text remains on disk.
 */
function encryptAndStoreContent(contentObj, photosArray) {
  if (!fs.existsSync(PRIVATE_STORAGE_DIR)) {
    fs.mkdirSync(PRIVATE_STORAGE_DIR, { recursive: true });
  }

  const payload = JSON.stringify({
    content: contentObj,
    photos: photosArray,
    encryptedAt: new Date().toISOString(),
  });

  const encryptedBuffer = encryptData(payload);
  fs.writeFileSync(ENCRYPTED_CONTENT_PATH, encryptedBuffer);
  console.log('[ContentService] Private experience encrypted and saved at:', ENCRYPTED_CONTENT_PATH);
}

/**
 * Loads private content.
 * STRICTURE: Refuses to read from disk or decrypt if isReleased() is false.
 */
function getPrivateExperience(testClock = null) {
  // 1. Release check precedes any file read or decryption
  if (!isReleased(testClock)) {
    const error = new Error('LOCKED: Private content cannot be decrypted before release time.');
    error.code = 'ERR_RELEASE_LOCKED';
    throw error;
  }

  // 2. Return cached if already decrypted
  if (decryptedCache) {
    return decryptedCache;
  }

  // 3. Read encrypted file and decrypt in-memory
  if (!fs.existsSync(ENCRYPTED_CONTENT_PATH)) {
    throw new Error('Encrypted experience file not found on server.');
  }

  const encryptedBuffer = fs.readFileSync(ENCRYPTED_CONTENT_PATH);
  const decryptedBuffer = decryptData(encryptedBuffer);
  const parsed = JSON.parse(decryptedBuffer.toString('utf8'));

  decryptedCache = parsed;
  return decryptedCache;
}

module.exports = {
  PRIVATE_STORAGE_DIR,
  ENCRYPTED_CONTENT_PATH,
  encryptAndStoreContent,
  getPrivateExperience,
};

