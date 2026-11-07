/**
 * Release Policy (Single Source of Truth)
 * 
 * Target: 2026-11-20T18:30:00Z (21 Nov 2026, 00:00:00 IST / Asia/Kolkata).
 * Server-side evaluation only using host UTC clock.
 * Fail-closed design: any error, invalid config, or skew defaults to locked.
 */

const DEFAULT_RELEASE_TIME_ISO = '2026-11-20T18:30:00Z';
const CANONICAL_RELEASE_INSTANT_MS = new Date(DEFAULT_RELEASE_TIME_ISO).getTime();

/**
 * Validates environment configuration on startup.
 * In production (NODE_ENV === 'production'), strictly rejects any release time
 * earlier than 2026-11-20T18:30:00Z and refuses to start.
 */
function validateProductionReleaseConfig() {
  if (process.env.NODE_ENV === 'production') {
    const envTime = process.env.PINKVERSE_RELEASE_TIME;
    if (envTime) {
      const parsed = new Date(envTime).getTime();
      if (isNaN(parsed)) {
        const msg = `[FATAL SECURITY CONFIG] PINKVERSE_RELEASE_TIME '${envTime}' is not a valid ISO date. Server refusing to start in production.`;
        console.error(msg);
        throw new Error(msg);
      }
      if (parsed < CANONICAL_RELEASE_INSTANT_MS) {
        const msg = `[FATAL SECURITY CONFIG] In production, PINKVERSE_RELEASE_TIME cannot be earlier than ${DEFAULT_RELEASE_TIME_ISO} (21 Nov 2026, 00:00:00 IST). Configured value: '${envTime}'. Server refusing to start.`;
        console.error(msg);
        throw new Error(msg);
      }
    }
  }
}

function getReleaseTimeISO() {
  const envTime = process.env.PINKVERSE_RELEASE_TIME;
  if (!envTime) return DEFAULT_RELEASE_TIME_ISO;
  
  // Validate ISO string parsing
  const parsed = new Date(envTime).getTime();
  if (isNaN(parsed)) {
    console.error('[ReleasePolicy] Invalid PINKVERSE_RELEASE_TIME env variable. Failing closed to default.');
    return DEFAULT_RELEASE_TIME_ISO;
  }

  // Production check
  if (process.env.NODE_ENV === 'production' && parsed < CANONICAL_RELEASE_INSTANT_MS) {
    console.error('[ReleasePolicy] Production release time earlier than canonical instant rejected. Failing closed.');
    return DEFAULT_RELEASE_TIME_ISO;
  }

  return envTime;
}

const { getCachedClockDriftStatus, verifyClockDrift } = require('./clockDriftVerifier.cjs');

// State latch: once release is confirmed, later drift-check failure must not re-lock the experience
let releaseConfirmed = false;

// Periodic clock drift check every 60 seconds (within 60-120s specification in final 2 hours)
if (process.env.NODE_ENV !== 'test') {
  verifyClockDrift().catch(() => {});
  const timer = setInterval(() => {
    verifyClockDrift().catch(() => {});
  }, 60 * 1000);
  if (timer.unref) timer.unref();
}

/**
 * Returns release status evaluated against host server clock.
 * Test clock override is ONLY accepted in test environments (NODE_ENV === 'test').
 */
function getReleaseStatus(testClock = null, testDriftCheck = false) {
  try {
    const releaseTimeISO = getReleaseTimeISO();
    const releaseInstant = new Date(releaseTimeISO).getTime();

    if (isNaN(releaseInstant)) {
      // Fail closed
      return {
        locked: true,
        serverNow: new Date().toISOString(),
        unlockAt: DEFAULT_RELEASE_TIME_ISO,
      };
    }

    // Determine current time
    let nowMs = Date.now();
    if (process.env.NODE_ENV === 'test' && testClock !== null) {
      if (typeof testClock === 'number') {
        nowMs = testClock;
      } else if (typeof testClock === 'string') {
        const parsed = new Date(testClock).getTime();
        if (!isNaN(parsed)) nowMs = parsed;
      }
    }

    const serverNowISO = new Date(nowMs).toISOString();

    // Latch check: Once release is confirmed, later drift failures never re-lock
    if (releaseConfirmed) {
      return {
        locked: false,
        serverNow: serverNowISO,
        unlockAt: releaseTimeISO,
      };
    }

    // Security check: within final 2 hours or after release,
    // require that external clock drift check is verified and <= 120s
    if (process.env.NODE_ENV !== 'test' || testDriftCheck) {
      const finalTwoHoursWindow = nowMs >= (releaseInstant - 2 * 60 * 60 * 1000);
      if (finalTwoHoursWindow) {
        const driftStatus = getCachedClockDriftStatus(nowMs);
        if (!driftStatus.ok) {
          console.error('[ReleasePolicy] External HTTPS clock drift check failed (> 120s or unreachable > 10m). Failing closed.');
          return {
            locked: true,
            serverNow: serverNowISO,
            unlockAt: releaseTimeISO,
          };
        }
      }
    }

    const isUnlocked = nowMs >= releaseInstant;
    if (isUnlocked) {
      releaseConfirmed = true; // Confirmed and latched!
    }

    return {
      locked: !isUnlocked,
      serverNow: serverNowISO,
      unlockAt: releaseTimeISO,
    };
  } catch (err) {
    // Fail closed on any exception
    return {
      locked: true,
      serverNow: new Date().toISOString(),
      unlockAt: DEFAULT_RELEASE_TIME_ISO,
    };
  }
}

function _resetReleaseConfirmedForTesting() {
  releaseConfirmed = false;
}

/**
 * Boolean helper: is the release currently active?
 */
function isReleased(testClock = null) {
  const status = getReleaseStatus(testClock);
  return !status.locked;
}

/**
 * Byte-identical locked response payload for all gated endpoints.
 * Prevents response length or structure oracle.
 */
const UNIFORM_LOCKED_PAYLOAD = Buffer.from(
  JSON.stringify({
    error: 'LOCKED',
    message: 'This private celebration has not yet been released.',
    unlockAt: DEFAULT_RELEASE_TIME_ISO,
  }),
  'utf8'
);

module.exports = {
  DEFAULT_RELEASE_TIME_ISO,
  CANONICAL_RELEASE_INSTANT_MS,
  validateProductionReleaseConfig,
  getReleaseTimeISO,
  getReleaseStatus,
  isReleased,
  UNIFORM_LOCKED_PAYLOAD,
  _resetReleaseConfirmedForTesting,
};
