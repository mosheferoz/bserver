const rateLimit = require('express-rate-limit');
const logger = require('../logger');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 דקות
  max: 10000, // מקסימום 100 בקשות לחלון זמן
  message: 'Too many requests from this IP, please try again later',
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Too many requests',
      details: 'Please try again later'
    });
  }
});

module.exports = limiter; 