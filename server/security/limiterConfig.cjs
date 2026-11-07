/**
 * Security Rate Limiter Configuration
 * Token bucket rate limiting with burst allowance, thumbnail discounts, and abuse detection.
 */

const IS_DEV = process.env.NODE_ENV !== 'production' || process.env.PINKVERSE_DEV_MODE === 'true';

const LIMITER_CONFIG = {
  // Token Bucket Capacity (maximum burst allowance per session)
  BUCKET_CAPACITY: 40,

  // Token refill rate (tokens added per second: 4 tokens/sec = 240 tokens/min)
  REFILL_RATE_PER_SEC: 4.0,

  // Token cost per image size
  // Thumbnails are discounted (0.3) so normal browsing through all 55 photos needs only ~16.5 tokens
  // Large viewing photos cost 1.5 tokens, preventing rapid mass extraction in seconds
  TOKEN_COST: {
    thumb: 0.3,    // Marquee & gallery grid thumbnails
    small: 0.3,    // Small cards
    medium: 0.8,   // Standard assets
    large: 1.5,    // Full viewing resolution assets
  },

  // Sequential Scraper Pattern Detection
  // Triggered when an automated script rapidly enumerates unique assets (e.g. 10 assets in < 1.5s)
  SCRAPING_THRESHOLD_COUNT: 10,
  SCRAPING_WINDOW_MS: 1500,

  // Sustained Abuse Lockout
  // Only revoke if client repeatedly ignores 429 Retry-After headers across multiple calls
  MAX_CONSECUTIVE_429_VIOLATIONS: 8,

  // Retry-After header duration in seconds
  RETRY_AFTER_SECONDS: 1,

  // Global IP rate limit (100 requests per minute per IP on photo/audio endpoints)
  MAX_REQUESTS_PER_MINUTE_PER_IP: 100,
};

module.exports = { LIMITER_CONFIG, IS_DEV };
