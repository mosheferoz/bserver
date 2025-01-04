const rateLimit = require('express-rate-limit');
const logger = require('../logger');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 דקות
  max: 100, // מקסימום 100 בקשות לחלון זמן
  message: 'Too many requests from this IP, please try again later',
  onLimitReached: (req) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}`);
  }
});

module.exports = limiter; 