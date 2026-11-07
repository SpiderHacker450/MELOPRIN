const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Safe loader for local .env if not present in process.env (local development only)
function loadEnvFile() {
  try {
    const envPath = path.join(__dirname, '..', '..', '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (e) {}
}

loadEnvFile();

/**
 * Retrieves the 256-bit encryption key.
 * STRICT: Loaded exclusively from environment variable PINKVERSE_CONTENT_KEY
 * (or gitignored .env for local development).
 * Key is NEVER stored in repo, storage/, dist/, or build outputs.
 */
function getContentKey() {
  loadEnvFile();
  const envKey = process.env.PINKVERSE_CONTENT_KEY;
  if (envKey && envKey.length === 64) {
    return Buffer.from(envKey, 'hex');
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('[FATAL SECURITY ERROR] PINKVERSE_CONTENT_KEY environment variable is missing or invalid in production.');
  }

  throw new Error('[SECURITY ERROR] PINKVERSE_CONTENT_KEY environment variable must be set (64-character hex string).');
}

/**
 * Encrypts arbitrary buffer or string using AES-256-GCM.
 * Output layout: [12-byte IV][16-byte Auth Tag][Ciphertext]
 */
function encryptData(data) {
  const key = getContentKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const inputBuffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(inputBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]);
}

/**
 * Decrypts AES-256-GCM encrypted package.
 * Input layout: [12-byte IV][16-byte Auth Tag][Ciphertext]
 */
function decryptData(encryptedBuffer) {
  if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length < 28) {
    throw new Error('Invalid encrypted buffer format');
  }

  const key = getContentKey();
  const iv = encryptedBuffer.subarray(0, 12);
  const tag = encryptedBuffer.subarray(12, 28);
  const ciphertext = encryptedBuffer.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = {
  getContentKey,
  encryptData,
  decryptData,
  loadEnvFile,
};
