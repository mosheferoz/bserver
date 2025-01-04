require('dotenv').config();
const path = require('path');

const firebaseConfig = process.env.FIREBASE_PROJECT_ID ? {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL
} : null;

module.exports = {
  server: {
    port: process.env.PORT || 3000,
    host: process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost',
    env: process.env.NODE_ENV || 'development'
  },
  firebase: firebaseConfig,
  whatsapp: {
    sessionPath: process.env.WHATSAPP_SESSION_PATH || path.join(__dirname, 'whatsapp-auth'),
    retryInterval: parseInt(process.env.WHATSAPP_RETRY_INTERVAL) || 5000,
    maxConcurrentMessages: parseInt(process.env.MAX_CONCURRENT_MESSAGES) || 5,
    messageDelayMs: parseInt(process.env.MESSAGE_DELAY_MS) || 1000,
    clientId: process.env.WHATSAPP_CLIENT_ID || 'client-one'
  },
  security: {
    jwtSecret: process.env.JWT_SECRET || 'default-secret-key',
    corsOrigin: process.env.CORS_ORIGIN || '*',
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100
  },
  logging: {
    level: process.env.LOG_LEVEL || 'debug',
    filePath: process.env.LOG_FILE_PATH || path.join(__dirname, 'logs', 'app.log'),
    maxSize: '10m',
    maxFiles: '7d'
  },
  scraping: {
    timeout: parseInt(process.env.SCRAPING_TIMEOUT) || 30000,
    userAgent: process.env.SCRAPING_USER_AGENT
  }
}; 