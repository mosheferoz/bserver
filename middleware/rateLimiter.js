const rateLimit = require('express-rate-limit');
const logger = require('../logger');

// Rate limiter עבור נתיבי סטטוס ו-QR
const statusQrLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // דקה אחת
  max: 60, // בקשה אחת בשנייה
  message: 'Too many status/QR requests from this IP, please try again later',
  onLimitReached: (req) => {
    logger.warn(`Status/QR rate limit exceeded for IP: ${req.ip}`);
  }
});

// Rate limiter כללי עבור שאר הנתיבים
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 דקות
  max: 100, // מקסימום 100 בקשות לחלון זמן
  message: 'Too many requests from this IP, please try again later',
  onLimitReached: (req) => {
    logger.warn(`General rate limit exceeded for IP: ${req.ip}`);
  }
});

module.exports = {
  statusQrLimiter,
  generalLimiter
}; 