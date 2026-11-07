const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', '..', 'storage', 'access_forensics.log');

// Ensure log directory exists
const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

function anonymizeIp(ip) {
  if (!ip) return 'unknown';
  // If IPv4: retain first 2 octets (e.g. 192.168.0.0/16)
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.x.x`;
    }
  }
  // If IPv6: retain first 3 blocks
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return `${parts.slice(0, 3).join(':')}::/48`;
  }
  return 'local';
}

/**
 * Appends a structured forensic record mapping session to action, photo, and IP range.
 * Never logs passcodes, secrets, or encryption keys.
 */
function recordForensicEvent(event) {
  const timestamp = new Date().toISOString();
  const sidShort = event.sid ? event.sid.substring(0, 8) + '...' : 'none';
  const ipRange = anonymizeIp(event.ip);
  const action = event.action || 'ACCESS';
  const resource = event.resource || 'unknown';
  const detail = event.detail ? ` detail="${event.detail}"` : '';

  const line = `[${timestamp}] ACTION=${action} SID=${sidShort} IP=${ipRange} RES=${resource}${detail}\n`;

  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) console.error('[Forensics] Failed to write log:', err.message);
  });
}

module.exports = {
  recordForensicEvent,
  anonymizeIp,
};

