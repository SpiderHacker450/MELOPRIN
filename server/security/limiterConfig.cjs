/**
 * Security Rate Limiter Configuration
 * Token bucket rate limiting with burst allowance, thumbnail discounts, and abuse detection.
 */

const IS_DEV = process.env.NODE_ENV !== 'production' || process.env.PINKVERSE_DEV_MODE === 'true';

const LIMITER_CONFIG = {
  // Token Bucket Capacity (maximum burst allowance)
  // Allows rapid resource navigation without triggering rate limits
  BUCKET_CAPACITY: IS_DEV ? 120 : 40,

  // Token refill rate (tokens added per second)
  REFILL_RATE_PER_SEC: IS_DEV ? 30 : 12,

  // Token cost per image size
  // Thumbnails are lightweight and discounted so galleries can load smoothly
  TOKEN_COST: {
    thumb: 0.5,    // Marquee & small grid tiles
    small: 0.5,    // Small cards
    medium: 0.8,   // Standard asset delivery
    large: 1.0,    // High-resolution display assets
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

  // Global IP rate limit (per minute)
  MAX_REQUESTS_PER_MINUTE_PER_IP: IS_DEV ? 600 : 200,
};

module.exports = { LIMITER_CONFIG, IS_DEV };
