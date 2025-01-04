const admin = require('firebase-admin');
const logger = require('../logger');

const firebaseAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      throw new Error('No token provided');
    }

    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    logger.error('Firebase authentication error:', error);
    res.status(401).json({ error: 'Please authenticate with Firebase' });
  }
};

module.exports = firebaseAuth; 