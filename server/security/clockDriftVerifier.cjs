const https = require('https');

let lastClockCheck = {
  timestamp: 0,
  driftSec: 0,
  ok: true,
  error: null,
};

const DRIFT_TOLERANCE_SECONDS = 120;
const CACHE_DURATION_MS = 60 * 1000; // Cache check for 60 seconds

function fetchExternalHttpsDate(url = 'https://cloudflare.com') {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'HEAD',
        timeout: 3000,
      },
      (res) => {
        const dateHeader = res.headers.date;
        if (!dateHeader) {
          reject(new Error('Missing Date header in response from ' + url));
          return;
        }
        const externalMs = new Date(dateHeader).getTime();
        if (isNaN(externalMs)) {
          reject(new Error('Invalid Date header: ' + dateHeader));
          return;
        }
        resolve(externalMs);
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout reaching ' + url));
    });

    req.on('error', reject);
    req.end();
  });
}

async function verifyClockDrift(forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && (now - lastClockCheck.timestamp < CACHE_DURATION_MS)) {
    return lastClockCheck;
  }

  try {
    let externalMs;
    try {
      externalMs = await fetchExternalHttpsDate('https://cloudflare.com');
    } catch {
      // Fallback secondary authority
      externalMs = await fetchExternalHttpsDate('https://www.google.com');
    }

    const driftSec = Math.abs((now - externalMs) / 1000);
    const ok = driftSec <= DRIFT_TOLERANCE_SECONDS;

    lastClockCheck = {
      timestamp: now,
      driftSec,
      ok,
      error: ok ? null : `Clock drift ${driftSec.toFixed(1)}s exceeds ${DRIFT_TOLERANCE_SECONDS}s limit`,
    };

    if (!ok) {
      console.error(`[ClockSecurity] FATAL: ${lastClockCheck.error}. Server will fail closed.`);
    }

    return lastClockCheck;
  } catch (err) {
    lastClockCheck = {
      timestamp: now,
      driftSec: 999,
      ok: false,
      error: `Failed to contact external HTTPS time authority: ${err.message}`,
    };
    return lastClockCheck;
  }
}

function getCachedClockDriftStatus() {
  return lastClockCheck;
}

module.exports = {
  fetchExternalHttpsDate,
  verifyClockDrift,
  getCachedClockDriftStatus,
  DRIFT_TOLERANCE_SECONDS,
};
