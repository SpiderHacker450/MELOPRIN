/**
 * PINKVERSE Passcode Manager (DECOMMISSIONED)
 * 
 * The passcode requirement has been removed from the unlocked experience.
 * Access after release is protected by release-time verification, HMAC session cookies,
 * per-IP rate limits, and origin link privacy.
 */

function validateProductionPasscode() {
  // No-op: PINKVERSE_PASSCODE is no longer required or checked.
}

function checkPasscode() {
  return {
    success: true,
    message: 'Passcode requirement decommissioned. Access granted.',
  };
}

module.exports = {
  checkPasscode,
  validateProductionPasscode,
};
