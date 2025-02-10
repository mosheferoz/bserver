const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const authMiddleware = require('../middleware/auth');
const logger = require('../logger');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.uid;
    const db = admin.firestore();
    
    const agentsSnapshot = await db
      .collection('users')
      .doc(userId)
      .collection('virtualAgents')
      .get();

    const agents = agentsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(agents);
  } catch (error) {
    logger.error('Error fetching virtual agents:', error);
    res.status(500).json({
      error: error.message,
      details: error.stack
    });
  }
});

module.exports = router; 