const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsapp.service');
const { db, admin } = require('../database/firebase');
const logger = require('../logger');
const authMiddleware = require('../middleware/auth');

// נתיבים שלא דורשים אימות
router.get('/qr/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      logger.error('Missing sessionId in QR request');
      return res.status(400).json({ 
        error: 'Missing sessionId',
        details: 'Session ID is required'
      });
    }

    logger.info(`QR code request received for session ${sessionId}`);
    
    // אם WhatsApp לא מחובר, נאתחל אותו
    if (!whatsappService.clients.has(sessionId)) {
      logger.info(`WhatsApp client not initialized for session ${sessionId}, initializing...`);
      await whatsappService.initialize(sessionId);
    }
    
    // נחכה קצת לקבלת ה-QR
    let attempts = 0;
    while (!whatsappService.qrCodes.has(sessionId) && attempts < 10) {
      logger.info(`Waiting for QR code, attempt ${attempts + 1}/10`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }

    if (!whatsappService.qrCodes.has(sessionId)) {
      logger.warn(`QR code not generated after waiting for session ${sessionId}`);
      return res.status(404).json({ 
        error: 'QR not available',
        details: 'QR code generation timeout'
      });
    }

    logger.info(`QR code found for session ${sessionId}, sending response`);
    res.json({ qr: whatsappService.getQR(sessionId) });
  } catch (error) {
    logger.error(`Error in /qr route for session ${req.params.sessionId}:`, error);
    res.status(500).json({ 
      error: 'Failed to get QR code',
      details: error.message
    });
  }
});

router.get('/status/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      logger.error('Missing sessionId in status request');
      return res.status(400).json({ 
        error: 'Missing sessionId',
        details: 'Session ID is required'
      });
    }

    logger.info(`Status request received for session ${sessionId}`);
    res.json(whatsappService.getStatus(sessionId));
  } catch (error) {
    logger.error(`Error in /status route for session ${req.params.sessionId}:`, error);
    res.status(500).json({ 
      error: 'Failed to get status',
      details: error.message
    });
  }
});

// נתיבים שדורשים אימות
router.use(authMiddleware);

router.post('/send', async (req, res) => {
  try {
    logger.info('Received send request - Full body:', req.body);
    
    const { phoneNumber, message, recipientName, sessionId, shouldArchive = false } = req.body;
    
    if (!sessionId) {
      logger.error('Missing sessionId in send request');
      return res.status(400).json({
        error: 'Missing sessionId',
        details: 'Session ID is required'
      });
    }
    
    // בדיקת חיבור WhatsApp
    if (!whatsappService.isConnected.get(sessionId)) {
      logger.error(`WhatsApp is not connected for session ${sessionId}`);
      return res.status(503).json({ 
        error: 'WhatsApp is not connected',
        details: 'Please scan QR code and wait for connection'
      });
    }

    // ודיקה שיש מספר טלפון
    if (!phoneNumber) {
      logger.error('Missing phone number');
      return res.status(400).json({
        error: 'Missing phone number',
        details: 'Phone number is required'
      });
    }

    // ניקוי וולידציה של מספר הטלפון
    const cleanPhoneNumber = phoneNumber.toString().replace(/[^\d]/g, '');
    
    if (!cleanPhoneNumber || !cleanPhoneNumber.match(/^\d{9,10}$/)) {
      logger.warn('Invalid phone number:', { 
        original: phoneNumber,
        cleaned: cleanPhoneNumber 
      });
      return res.status(400).json({ 
        error: 'Invalid phone number',
        details: 'Phone number must be 9-10 digits'
      });
    }

    // טיפול בהודעה - אם אין הודעה, נשתמש בערך ריק
    let finalMessage = req.body.message || '';
    
    try {
      // אם יש שם נמען ויש תבנית {name} בהודעה, נחליף אותה
      if (recipientName && finalMessage.includes('{name}')) {
        finalMessage = finalMessage.replace('{name}', recipientName.trim());
      }
      
      logger.info('Message processing:', {
        original: message,
        final: finalMessage,
        recipientName: recipientName || 'not provided'
      });

      const result = await whatsappService.sendMessage(sessionId, cleanPhoneNumber, finalMessage);
      
      // אם נדרש לארכב את הצ'אט
      if (shouldArchive && result.chatId) {
        try {
          await whatsappService.archiveChat(sessionId, result.chatId);
          logger.info(`Chat archived successfully for ${cleanPhoneNumber}`);
        } catch (archiveError) {
          logger.warn('Failed to archive chat:', archiveError);
        }
      }
      
      // שמירת היסטוריה אם Firebase זמין
      try {
        if (db && admin) {
          await db.collection('message_history').add({
            sessionId,
            phoneNumber: cleanPhoneNumber,
            message: finalMessage,
            status: 'sent',
            archived: shouldArchive,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
          logger.info('Message history saved to Firebase');
        }
      } catch (dbError) {
        logger.warn('Failed to save message history:', dbError);
      }
      
      logger.info('Message sent successfully');
      res.json({ 
        success: true,
        phoneNumber: cleanPhoneNumber,
        message: finalMessage,
        archived: shouldArchive
      });
    } catch (error) {
      logger.error('Error processing message:', error);
      res.status(500).json({ 
        error: 'Failed to process message',
        details: error.message
      });
    }
  } catch (error) {
    logger.error('Error in /send:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.stack
    });
  }
});

router.post('/archive', async (req, res) => {
  try {
    const { sessionId, chatId } = req.body;
    
    if (!sessionId || !chatId) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'Session ID and Chat ID are required'
      });
    }

    await whatsappService.archiveChat(sessionId, chatId);
    
    res.json({ 
      success: true,
      message: 'Chat archived successfully'
    });
  } catch (error) {
    logger.error('Error in /archive:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.stack
    });
  }
});

router.post('/history', async (req, res) => {
  try {
    // בדיקה אם Firebase זמין
    if (!db || !admin) {
      logger.warn('Firebase is not configured, history feature is disabled');
      return res.status(503).json({
        error: 'History feature is disabled',
        details: 'Firebase is not configured'
      });
    }

    logger.info('Received history request - Full body:', req.body);
    logger.info('Headers:', req.headers);
    
    const { phoneNumber, message, status, sessionId } = req.body;
    logger.info('Extracted fields:', { phoneNumber, message, status, sessionId });
    
    if (!phoneNumber || !message || !sessionId) {
      logger.warn('Missing required fields for history:', { 
        hasPhoneNumber: !!phoneNumber, 
        hasMessage: !!message,
        hasSessionId: !!sessionId,
        body: JSON.stringify(req.body)
      });
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: { 
          hasPhoneNumber: !!phoneNumber, 
          hasMessage: !!message,
          hasSessionId: !!sessionId,
          receivedFields: Object.keys(req.body),
          fullBody: req.body
        }
      });
    }

    const docRef = await db.collection('message_history').add({
      sessionId,
      phoneNumber,
      message,
      status: status || 'pending',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    logger.info('History saved successfully:', { id: docRef.id });
    res.json({ 
      success: true,
      id: docRef.id
    });
  } catch (error) {
    logger.error('Error in /history:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.stack
    });
  }
});

router.post('/disconnect/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      logger.error('Missing sessionId in disconnect request');
      return res.status(400).json({ 
        error: 'Missing sessionId',
        details: 'Session ID is required'
      });
    }

    logger.info(`Disconnect request received for session ${sessionId}`);
    
    if (whatsappService.clients.has(sessionId)) {
      await whatsappService.cleanupAuthFolder(sessionId);
      logger.info(`Session ${sessionId} disconnected successfully`);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error(`Error in /disconnect route for session ${req.params.sessionId}:`, error);
    res.status(500).json({ 
      error: 'Failed to disconnect',
      details: error.message
    });
  }
});

module.exports = router; 