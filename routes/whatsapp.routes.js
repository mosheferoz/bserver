const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsapp.service');
const whatsappGroupsService = require('../services/whatsapp-groups.service');
const { db, admin } = require('../database/firebase');
const logger = require('../logger');
const authMiddleware = require('../middleware/auth');
const rasaService = require('../services/rasa.service');

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
    const isConnected = whatsappService.isConnected.get(sessionId) || false;
    const hasQR = whatsappService.qrCodes.has(sessionId);
    res.json({ 
      connected: isConnected,
      hasQR: hasQR,
      status: isConnected ? 'CONNECTED' : (hasQR ? 'NEED_SCAN' : 'DISCONNECTED')
    });
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
          // מבוטל - לא שומרים היסטוריה יותר
          // await db.collection('message_history').add({
          //   sessionId,
          //   phoneNumber: cleanPhoneNumber,
          //   message: finalMessage,
          //   status: 'sent',
          //   archived: shouldArchive,
          //   timestamp: admin.firestore.FieldValue.serverTimestamp()
          // });
          // logger.info('Message history saved to Firebase');
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
    // מבוטל - לא שומרים היסטוריה יותר
    res.json({ success: true });
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

router.get('/groups/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      logger.error('Missing sessionId in groups request');
      return res.status(400).json({ 
        error: 'Missing sessionId',
        details: 'Session ID is required'
      });
    }

    logger.info(`Groups list request received for session ${sessionId}`);
    
    if (!whatsappService.isConnected.get(sessionId)) {
      logger.error(`WhatsApp is not connected for session ${sessionId}`);
      return res.status(503).json({ 
        error: 'WhatsApp is not connected',
        details: 'Please connect WhatsApp first'
      });
    }

    const groups = await whatsappService.getGroups(sessionId);
    res.json({ groups });
  } catch (error) {
    logger.error(`Error in /groups route for session ${req.params.sessionId}:`, error);
    res.status(500).json({ 
      error: 'Failed to get groups',
      details: error.message
    });
  }
});

router.get('/groups/:sessionId/:groupId', async (req, res) => {
  try {
    const { sessionId, groupId } = req.params;
    
    if (!sessionId || !groupId) {
      logger.error('Missing required parameters');
      return res.status(400).json({ 
        error: 'Missing parameters',
        details: 'Session ID and Group ID are required'
      });
    }

    logger.info(`Group details request received for group ${groupId} in session ${sessionId}`);
    
    if (!whatsappService.isConnected.get(sessionId)) {
      logger.error(`WhatsApp is not connected for session ${sessionId}`);
      return res.status(503).json({ 
        error: 'WhatsApp is not connected',
        details: 'Please connect WhatsApp first'
      });
    }

    try {
      const groupDetails = await whatsappService.getGroupDetails(sessionId, groupId);
      
      // בדיקה נוספת שיש לנו מידע תקין
      if (!groupDetails || !groupDetails.id) {
        throw new Error('Invalid group details received');
      }
      
      // בדיקה שיש לנו משתתפים
      if (!groupDetails.participants || groupDetails.participants.length === 0) {
        logger.warn(`No participants found for group ${groupId}`);
      }
      
      res.json({ group: groupDetails });
    } catch (groupError) {
      logger.error(`Error getting group details: ${groupError.message}`);
      
      // שליחת תשובה עם פרטי השגיאה
      res.status(400).json({ 
        error: 'Failed to get group details',
        details: groupError.message,
        group: {
          id: groupId,
          name: 'Unknown Group',
          participantsCount: 0,
          description: '',
          isReadOnly: false,
          participants: [],
          isConnected: false,
          error: groupError.message
        }
      });
    }
  } catch (error) {
    logger.error(`Error in /groups/:sessionId/:groupId route:`, error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message
    });
  }
});

// נתיבים חדשים לתמיכה ב-Rasa
router.post('/auto-reply/enable', authMiddleware, async (req, res) => {
  try {
    const { sessionId, eventId, agentId } = req.body;
    
    if (!sessionId || !eventId || !agentId) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'Session ID, Event ID, and Agent ID are required'
      });
    }

    // בדיקה שה-WhatsApp מחובר
    if (!whatsappService.isConnected.get(sessionId)) {
      return res.status(503).json({
        error: 'WhatsApp is not connected',
        details: 'Please connect WhatsApp first'
      });
    }

    // הפעלת מענה אוטומטי
    const success = await whatsappService.enableAutoReply(sessionId, eventId, agentId);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(500).json({
        error: 'Failed to enable auto-reply',
        details: 'Internal server error'
      });
    }
  } catch (error) {
    logger.error('Error in /auto-reply/enable:', error);
    res.status(500).json({
      error: error.message,
      details: error.stack
    });
  }
});

router.post('/auto-reply/disable', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({
        error: 'Missing session ID',
        details: 'Session ID is required'
      });
    }

    // כיבוי מענה אוטומטי
    const success = await whatsappService.disableAutoReply(sessionId);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(500).json({
        error: 'Failed to disable auto-reply',
        details: 'Internal server error'
      });
    }
  } catch (error) {
    logger.error('Error in /auto-reply/disable:', error);
    res.status(500).json({
      error: error.message,
      details: error.stack
    });
  }
});

router.get('/auto-reply/status/:sessionId', authMiddleware, (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({
        error: 'Missing session ID',
        details: 'Session ID is required'
      });
    }

    // בדיקת סטטוס מענה אוטומטי
    const autoReplyInfo = whatsappService.autoReplyEnabled.get(sessionId);
    
    res.json({
      enabled: !!autoReplyInfo,
      eventId: autoReplyInfo?.eventId,
      agentId: autoReplyInfo?.agentId
    });
  } catch (error) {
    logger.error('Error in /auto-reply/status:', error);
    res.status(500).json({
      error: error.message,
      details: error.stack
    });
  }
});

router.post('/rasa/train', authMiddleware, async (req, res) => {
  try {
    await rasaService.trainModel();
    res.json({ success: true });
  } catch (error) {
    logger.error('Error training Rasa model:', error);
    res.status(500).json({
      error: error.message,
      details: error.stack
    });
  }
});

// נתיב חדש לעדכון קבוצות
router.post('/groups/update', authMiddleware, async (req, res) => {
  try {
    const { sessionId, groupUpdate } = req.body;
    
    logger.info('Received group update request:', { sessionId, groupUpdate });
    
    if (!sessionId || !groupUpdate) {
      return res.status(400).json({
        error: 'חסרים שדות חובה',
        details: 'נדרש מזהה סשן ופרטי עדכון'
      });
    }

    // בדיקה שה-WhatsApp מחובר
    if (!whatsappService.isConnected.get(sessionId)) {
      return res.status(503).json({
        error: 'WhatsApp לא מחובר',
        details: 'יש להתחבר ל-WhatsApp תחילה'
      });
    }

    // וולידציה של פרטי העדכון
    const validation = await whatsappGroupsService.validateGroupUpdate(groupUpdate);
    if (!validation.isValid) {
      return res.status(400).json({
        error: 'נתוני עדכון לא תקינים',
        details: validation.errors
      });
    }

    // קבלת הלקוח של WhatsApp
    const client = whatsappService.clients.get(sessionId);
    if (!client) {
      return res.status(503).json({
        error: 'לקוח WhatsApp לא נמצא',
        details: 'יש להתחבר מחדש'
      });
    }

    // ביצוע העדכון
    const result = await whatsappGroupsService.updateGroups(client, groupUpdate);
    
    // אם יש עדכונים שנכשלו, ננסה שוב
    if (result.errors && result.errors.length > 0) {
      logger.info('מנסה שוב עדכונים שנכשלו...');
      const retryResult = await whatsappGroupsService.retryFailedUpdates(client, result.errors);
      
      // מיזוג תוצאות הניסיון החוזר עם התוצאות המקוריות
      result.results = [...result.results, ...retryResult.results];
      result.errors = retryResult.errors;
      result.totalUpdated += retryResult.results.length;
      result.totalFailed = retryResult.errors.length;
    }

    logger.info('Group update completed:', result);
    res.json(result);
    
  } catch (error) {
    logger.error('Error in /groups/update:', error);
    res.status(500).json({
      error: 'שגיאה בעדכון הקבוצות',
      details: error.message
    });
  }
});

module.exports = router; 