const https = require('https');

const DRIFT_TOLERANCE_SECONDS = 120;
const LAST_GOOD_VALIDITY_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_DURATION_MS = 60 * 1000; // Cache check for 60 seconds

let lastGoodCheck = {
  timestamp: 0,
  driftSec: 0,
};

let lastClockCheck = {
  timestamp: 0,
  driftSec: 0,
  ok: true,
  error: null,
  fallbackToLastGood: false,
};

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

/**
 * Validates host clock drift against authoritative HTTPS endpoints.
 * - In final 2 hours, evaluated periodically every 60-120 seconds.
 * - Last good check remains valid for 10 minutes so transient network glitches do not lock release.
 * - If measured drift exceeds 120s, fails closed immediately.
 */
async function verifyClockDrift(forceFresh = false, customNow = null) {
  const now = customNow || Date.now();
  if (!forceFresh && (now - lastClockCheck.timestamp < CACHE_DURATION_MS)) {
    return getCachedClockDriftStatus(now);
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

    if (ok) {
      lastGoodCheck = {
        timestamp: now,
        driftSec,
      };
      lastClockCheck = {
        timestamp: now,
        driftSec,
        ok: true,
        error: null,
        fallbackToLastGood: false,
      };
    } else {
      // Active drift violation: invalidate last good check and fail closed
      lastGoodCheck = {
        timestamp: 0,
        driftSec,
      };
      lastClockCheck = {
        timestamp: now,
        driftSec,
        ok: false,
        error: `Clock drift ${driftSec.toFixed(1)}s exceeds ${DRIFT_TOLERANCE_SECONDS}s limit`,
        fallbackToLastGood: false,
      };
      console.error(`[ClockSecurity] FATAL: ${lastClockCheck.error}. Server will fail closed.`);
    }

    return lastClockCheck;
  } catch (err) {
    // Check failed (network timeout / unreachable)
    // Rule: Keep last good check valid for 10 minutes
    const hasValidLastGood = lastGoodCheck.timestamp > 0 &&
      (now - lastGoodCheck.timestamp) <= LAST_GOOD_VALIDITY_MS;

    if (hasValidLastGood) {
      lastClockCheck = {
        timestamp: now,
        driftSec: lastGoodCheck.driftSec,
        ok: true,
        error: null,
        fallbackToLastGood: true,
      };
      console.warn(`[ClockSecurity] HTTPS check failed (${err.message}), using last verified good check from ${Math.round((now - lastGoodCheck.timestamp) / 1000)}s ago (within 10-minute validity window).`);
    } else {
      lastClockCheck = {
        timestamp: now,
        driftSec: 999,
        ok: false,
        error: `Failed to contact external HTTPS time authority and no good check in last 10 minutes: ${err.message}`,
        fallbackToLastGood: false,
      };
      console.error(`[ClockSecurity] FATAL: ${lastClockCheck.error}. Server will fail closed.`);
    }

    return lastClockCheck;
  }
}

/**
 * Returns currently cached status, re-evaluating the 10-minute fallback window against current time.
 */
function getCachedClockDriftStatus(nowMs = null) {
  const now = nowMs || Date.now();
  if (lastClockCheck.ok) {
    // If it was ok because of fallback or original good check, confirm that good check is still within 10 minutes
    if (lastGoodCheck.timestamp > 0) {
      const ageMs = now - lastGoodCheck.timestamp;
      if (ageMs > LAST_GOOD_VALIDITY_MS) {
        return {
          timestamp: now,
          driftSec: 999,
          ok: false,
          error: `Last good clock check expired (${Math.round(ageMs / 1000)}s > 600s tolerance).`,
          fallbackToLastGood: false,
        };
      }
    }
    return lastClockCheck;
  }
  return lastClockCheck;
}

/**
 * Direct injection for unit testing edge cases (transient failure, 30m failure, drift > 120s, recovery)
 */
function _injectCheckResultForTesting({ driftSec, isNetworkError, nowMs }) {
  const now = nowMs || Date.now();
  if (isNetworkError) {
    const hasValidLastGood = lastGoodCheck.timestamp > 0 &&
      (now - lastGoodCheck.timestamp) <= LAST_GOOD_VALIDITY_MS;

    if (hasValidLastGood) {
      lastClockCheck = {
        timestamp: now,
        driftSec: lastGoodCheck.driftSec,
        ok: true,
        error: null,
        fallbackToLastGood: true,
      };
    } else {
      lastClockCheck = {
        timestamp: now,
        driftSec: 999,
        ok: false,
        error: 'Network failure with expired/missing last good check (> 10 min)',
        fallbackToLastGood: false,
      };
    }
  } else {
    const ok = driftSec <= DRIFT_TOLERANCE_SECONDS;
    if (ok) {
      lastGoodCheck = { timestamp: now, driftSec };
      lastClockCheck = { timestamp: now, driftSec, ok: true, error: null, fallbackToLastGood: false };
    } else {
      lastGoodCheck = { timestamp: 0, driftSec };
      lastClockCheck = { timestamp: now, driftSec, ok: false, error: `Drift ${driftSec}s > 120s`, fallbackToLastGood: false };
    }
  }
  return lastClockCheck;
}

function _resetClockDriftStateForTesting() {
  lastGoodCheck = { timestamp: 0, driftSec: 0 };
  lastClockCheck = { timestamp: 0, driftSec: 0, ok: true, error: null, fallbackToLastGood: false };
}

module.exports = {
  fetchExternalHttpsDate,
  verifyClockDrift,
  getCachedClockDriftStatus,
  _injectCheckResultForTesting,
  _resetClockDriftStateForTesting,
  DRIFT_TOLERANCE_SECONDS,
  LAST_GOOD_VALIDITY_MS,
};
