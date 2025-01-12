const { admin } = require('../database/firebase');
const config = require('../config');
const logger = require('../logger');

module.exports = async (req, res, next) => {
  try {
    // אם אין Firebase מוגדר, נבדוק רק את ה-JWT
    if (!admin) {
      const token = req.headers.authorization?.split(' ')[1];
      
      if (!token) {
        logger.warn('No token provided');
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (token === config.security.jwtSecret) {
        req.user = { id: 'default-user' };
        return next();
      }

      logger.warn('Invalid JWT token');
      return res.status(401).json({ error: 'Invalid token' });
    }

    // אם יש Firebase, נבצע אימות מלא
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      logger.warn('No token provided');
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      // אימות מול Firebase
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.user = decodedToken;
      next();
    } catch (error) {
      logger.error('Firebase token verification failed:', error);
      return res.status(401).json({ 
        error: 'Invalid token',
        details: error.message
      });
    }
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(401).json({ 
      error: 'Authentication failed',
      details: error.message
    });
  }
}; 