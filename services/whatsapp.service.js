const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const { rimraf } = require('rimraf');
const config = require('../config');
const logger = require('../logger');
const path = require('path');
const { LocalAuth } = require('whatsapp-web.js');
const csv = require('csv-parser');
const virtualAgentService = require('./virtual-agent.service');
const admin = require('firebase-admin');
const rasaWhatsAppService = require('./rasa-whatsapp.service');
const rasaService = require('./rasa.service');

class WhatsAppService {
  constructor() {
    this.clients = new Map();
    this.qrCodes = new Map();
    this.isConnected = new Map();
    this.isInitializing = new Map();
    this.authPath = path.join(__dirname, '../whatsapp-auth');
    this.autoReplyEnabled = new Map(); // sessionId -> { eventId, agentId }
    this.io = null;
    this.keepAliveIntervals = new Map(); // מוסיף מעקב אחר ה-intervals
  }

  setSocketIO(io) {
    this.io = io;
    this.setupSocketEvents();
  }

  setupSocketEvents() {
    if (!this.io) return;

    this.io.on('connection', (socket) => {
      logger.info(`Socket connected: ${socket.id}`);

      socket.on('whatsapp:status', async (sessionId) => {
        const isConnected = this.isConnected.get(sessionId) || false;
        const hasQR = this.qrCodes.has(sessionId);
        socket.emit('whatsapp:status:response', {
          connected: isConnected,
          hasQR: hasQR,
          status: isConnected ? 'CONNECTED' : (hasQR ? 'NEED_SCAN' : 'DISCONNECTED')
        });
      });

      socket.on('disconnect', () => {
        logger.info(`Socket disconnected: ${socket.id}`);
      });
    });
  }

  // פונקציה לקבלת קוד QR
  getQR(sessionId) {
    return this.qrCodes.get(sessionId);
  }

  async cleanupAuthFolder(sessionId) {
    try {
      logger.info(`Starting auth folder cleanup for session ${sessionId}...`);
      const sessionPath = path.join(this.authPath, `session-${sessionId}`);

      // נסה לנתק את הלקוח בצורה מסודרת
      if (this.clients.has(sessionId)) {
        const client = this.clients.get(sessionId);
        if (client) {
          try {
            await client.logout().catch(err => logger.warn('Logout error:', err));
            await client.destroy().catch(err => logger.warn('Destroy error:', err));
          } catch (err) {
            logger.warn('Client cleanup error:', err);
          } finally {
            this.clients.delete(sessionId);
            this.qrCodes.delete(sessionId);
            this.isConnected.set(sessionId, false);
            logger.info(`Client resources cleaned for session ${sessionId}`);
          }
        }
      }

      // המתנה לפני המשך הניקוי
      await new Promise(resolve => setTimeout(resolve, 3000));

      if (fs.existsSync(sessionPath)) {
        try {
          // מחיקת התיקייה עם rimraf
          await rimraf(sessionPath, { 
            maxRetries: 5,
            recursive: true,
            force: true
          });
          
          logger.info('Session folder removed successfully');
        } catch (err) {
          logger.error('Error removing session folder:', err);
          // אם rimraf נכשל, ננסה למחוק עם fs-extra
          try {
            await fs.remove(sessionPath);
            logger.info('Session folder removed with fs-extra');
          } catch (fsErr) {
            logger.error('Error removing session folder with fs-extra:', fsErr);
          }
        }
      }

      // יצירת תיקייה חדשה
      try {
        await fs.ensureDir(sessionPath);
        logger.info('Session folder recreated');
        return sessionPath;
      } catch (mkdirErr) {
        logger.error('Error creating new session folder:', mkdirErr);
        throw mkdirErr;
      }

    } catch (error) {
      logger.error('Error in cleanupAuthFolder:', error);
      throw error;
    } finally {
      if (this.keepAliveIntervals.has(sessionId)) {
        clearInterval(this.keepAliveIntervals.get(sessionId));
        this.keepAliveIntervals.delete(sessionId);
        logger.info(`Cleared keep-alive interval for session ${sessionId}`);
      }
    }
  }

  async initialize(sessionId) {
    if (this.isInitializing.get(sessionId)) {
      logger.info(`WhatsApp client is already initializing for session ${sessionId}`);
      return;
    }

    try {
      this.isInitializing.set(sessionId, true);
      this.isConnected.set(sessionId, false);
      logger.info(`Starting WhatsApp client initialization for session ${sessionId}...`);

      const sessionPath = await this.cleanupAuthFolder(sessionId);
      
      const client = new Client({
        restartOnAuthFail: true,
        authStrategy: new LocalAuth({
          clientId: sessionId,
          dataPath: path.dirname(sessionPath)
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--aggressive-cache-discard',
            '--disable-cache',
            '--disable-application-cache',
            '--disable-offline-load-stale-cache',
            '--disk-cache-size=0'
          ],
          timeout: 120000,
          waitForInitialPage: true,
        }
      });

      client.on('ready', () => {
        this.isConnected.set(sessionId, true);
        this.qrCodes.delete(sessionId);
        logger.info(`WhatsApp client is ready!`);
        if (this.io) {
          this.io.emit('whatsapp:ready', { sessionId });
        }
        
        // מוסיף בדיקת חיבור תקופתית
        this.setupKeepAlive(sessionId, client);
      });

      client.on('qr', async (qr) => {
        try {
          logger.info(`Received QR code from WhatsApp for session ${sessionId}`);
          const qrCode = await qrcode.toDataURL(qr);
          this.qrCodes.set(sessionId, qrCode);
          logger.info('QR code converted to data URL');
          if (this.io) {
            this.io.emit('whatsapp:qr', { sessionId, qr: qrCode });
          }
        } catch (error) {
          logger.error('Error generating QR code:', error);
          this.qrCodes.delete(sessionId);
        }
      });

      client.on('authenticated', () => {
        this.isConnected.set(sessionId, true);
        this.qrCodes.delete(sessionId);
        logger.info(`WhatsApp client authenticated for session ${sessionId}`);
        if (this.io) {
          this.io.emit('whatsapp:authenticated', { sessionId });
        }
      });

      client.on('auth_failure', async (err) => {
        this.isConnected.set(sessionId, false);
        this.qrCodes.delete(sessionId);
        logger.error(`WhatsApp authentication failed for session ${sessionId}:`, err);
        if (this.io) {
          this.io.emit('whatsapp:auth_failure', { sessionId, error: err.message });
        }
        
        await this.cleanupAuthFolder(sessionId);
        setTimeout(() => this.initialize(sessionId), 5000);
      });

      client.on('disconnected', async (reason) => {
        this.isConnected.set(sessionId, false);
        this.qrCodes.delete(sessionId);
        logger.error(`WhatsApp client disconnected for session ${sessionId}:`, reason);
        if (this.io) {
          this.io.emit('whatsapp:disconnected', { sessionId, reason });
        }
        
        try {
          await this.cleanupAuthFolder(sessionId);
          
          setTimeout(() => {
            if (!this.isInitializing.get(sessionId)) {
              this.initialize(sessionId);
            }
          }, 10000);
        } catch (error) {
          logger.error('Error handling disconnection:', error);
        }
      });

      client.on('message', async (message) => {
        try {
          // בדיקה שהחיבור פעיל
          if (!this.isConnected.get(sessionId)) {
            logger.warn(`WhatsApp client is not connected for session ${sessionId}`);
            return;
          }

          logger.info(`Received message in session ${sessionId} from ${message.from}: ${message.body}`);
          
          const autoReplyInfo = this.autoReplyEnabled.get(sessionId);
          logger.info(`Auto-reply status for session ${sessionId}:`, autoReplyInfo);
          
          if (autoReplyInfo) {
            logger.info(`Auto-reply is enabled for session ${sessionId} with event ${autoReplyInfo.eventId} and agent ${autoReplyInfo.agentId}`);
            
            // העברת ההודעה ל-Rasa וקבלת תשובה
            const phoneNumber = message.from.split('@')[0].replace('972', '');
            logger.info(`Sending message to Rasa for ${phoneNumber}: ${message.body}`);
            
            const responses = await rasaService.sendMessage(message.body, phoneNumber);
            logger.info(`Received responses from Rasa:`, responses);
            
            // שליחת כל התשובות בחזרה למשתמש
            for (const response of responses) {
              if (response.text) {
                // קבלת פרטי האירוע והנציג
                const eventDetails = await this.getEventDetails(autoReplyInfo.eventId);
                const agentDetails = await this.getAgentDetails(autoReplyInfo.agentId);
                
                // מחליף את המשתנים בהודעה
                const processedMessage = response.text
                  .replace('{agent_name}', agentDetails?.name || 'הנציג הווירטואלי')
                  .replace('{event_name}', eventDetails?.eventName || 'האירוע')
                  .replace('{event_date}', eventDetails?.eventDate || 'לא צוין')
                  .replace('{event_info}', eventDetails?.eventInfo || 'אין מידע נוסף')
                  .replace('{event_link}', eventDetails?.eventLink || 'לא צוין')
                  .replace('{price}', eventDetails?.customFields?.price || 'לא צוין')
                  .replace('{discount_info}', eventDetails?.customFields?.discountInfo || 'אין מידע על הנחות')
                  // מיקום ופרטי מקום
                  .replace('{location}', eventDetails?.customFields?.location || 'לא צוין')
                  .replace('{venue_name}', eventDetails?.customFields?.venueName || '')
                  .replace('{address}', eventDetails?.customFields?.address || 'לא צוין')
                  .replace('{parking_info}', eventDetails?.customFields?.parkingInfo || 'אין מידע על חניה')
                  .replace('{accessibility}', eventDetails?.customFields?.accessibility || 'אין מידע על נגישות')
                  // גילאים ומגבלות
                  .replace('{age_restriction}', eventDetails?.customFields?.ageRestriction || 'אין הגבלת גיל')
                  .replace('{min_age}', eventDetails?.customFields?.minAge || 'לא צוין')
                  .replace('{max_age}', eventDetails?.customFields?.maxAge || 'לא צוין')
                  // כרטיסים ומחירים
                  .replace('{ticket_types}', eventDetails?.customFields?.ticketTypes || 'לא צוין')
                  .replace('{vip_price}', eventDetails?.customFields?.vipPrice || 'לא צוין')
                  .replace('{regular_price}', eventDetails?.customFields?.regularPrice || 'לא צוין')
                  .replace('{student_price}', eventDetails?.customFields?.studentPrice || 'לא צוין')
                  .replace('{group_discount}', eventDetails?.customFields?.groupDiscount || 'אין הנחת קבוצות')
                  .replace('{early_bird_price}', eventDetails?.customFields?.earlyBirdPrice || 'לא צוין')
                  .replace('{last_minute_price}', eventDetails?.customFields?.lastMinutePrice || 'לא צוין')
                  // זמנים
                  .replace('{start_time}', eventDetails?.customFields?.startTime || 'לא צוין')
                  .replace('{end_time}', eventDetails?.customFields?.endTime || 'לא צוין')
                  .replace('{doors_open}', eventDetails?.customFields?.doorsOpen || 'לא צוין')
                  // תוכן ומידע נוסף
                  .replace('{performers}', eventDetails?.customFields?.performers || 'כרגע בהפתעה')
                  .replace('{special_guests}', eventDetails?.customFields?.specialGuests || '' )
                  .replace('{program}', eventDetails?.customFields?.program || 'אין מידע על התוכנית')
                  .replace('{dress_code}', eventDetails?.customFields?.dressCode || 'אין קוד לבוש מיוחד')
                  .replace('{food_drinks}', eventDetails?.customFields?.foodDrinks || 'אין מידע על אוכל ושתייה')
                  .replace('{kosher_info}', eventDetails?.customFields?.kosherInfo || 'אין מידע על כשרות')
                  // הנחות ומבצעים
                  .replace('{family_discount}', eventDetails?.customFields?.familyDiscount || 'אין הנחת משפחה')
                  .replace('{military_discount}', eventDetails?.customFields?.militaryDiscount || 'אין הנחת חיילים')
                  .replace('{student_discount}', eventDetails?.customFields?.studentDiscount || 'אין הנחת סטודנט')
                  .replace('{member_discount}', eventDetails?.customFields?.memberDiscount || 'אין הנחת מנוי')
                  // פרטים טכניים
                  .replace('{capacity}', eventDetails?.customFields?.capacity || 'לא צוין')
                  .replace('{seating_type}', eventDetails?.customFields?.seatingType || 'לא צוין')
                  .replace('{sound_system}', eventDetails?.customFields?.soundSystem || 'לא צוין')
                  .replace('{stage_info}', eventDetails?.customFields?.stageInfo || 'לא צוין')
                  // מידע ארגוני
                  .replace('{organizer}', eventDetails?.customFields?.organizer || 'לא צוין')
                  .replace('{contact_person}', eventDetails?.customFields?.contactPerson || 'לא צוין')
                  .replace('{contact_phone}', eventDetails?.customFields?.contactPhone || 'לא צוין')
                  .replace('{contact_email}', eventDetails?.customFields?.contactEmail || 'לא צוין')
                  // תנאים והגבלות
                  .replace('{cancellation_policy}', eventDetails?.customFields?.cancellationPolicy || 'אין מידע על מדיניות ביטולים')
                  .replace('{refund_policy}', eventDetails?.customFields?.refundPolicy || 'אין מידע על מדיניות החזרים')
                  .replace('{terms_conditions}', eventDetails?.customFields?.termsConditions || 'אין מידע על תנאים והגבלות')
                  // שונות
                  .replace('{photography_policy}', eventDetails?.customFields?.photographyPolicy || 'אין מידע על מדיניות צילום')
                  .replace('{recording_policy}', eventDetails?.customFields?.recordingPolicy || 'אין מידע על מדיניות הקלטה')
                  .replace('{social_media}', eventDetails?.customFields?.socialMedia || 'אין מידע על רשתות חברתיות')
                  .replace('{hashtags}', eventDetails?.customFields?.hashtags || 'אין האשטגים')
                  .replace('{sponsors}', eventDetails?.customFields?.sponsors || 'אין ספונסרים')
                  .replace('{partners}', eventDetails?.customFields?.partners || 'אין שותפים');

                logger.info(`Processed message for session ${sessionId}: ${processedMessage}`);
                
                // בדיקה נוספת שהחיבור עדיין פעיל לפני שליחת התשובה
                if (this.isConnected.get(sessionId)) {
                  await client.sendMessage(message.from, processedMessage);
                } else {
                  logger.warn(`Cannot send response - WhatsApp client is not connected for session ${sessionId}`);
                }
              }
            }
          } else {
            logger.info(`Auto-reply is not enabled for session ${sessionId}`);
          }
        } catch (error) {
          logger.error('Error handling incoming message:', error);
        }
      });

      await client.initialize();
      this.clients.set(sessionId, client);
      logger.info(`WhatsApp client initialized successfully for session ${sessionId}`);
    } catch (error) {
      logger.error(`WhatsApp initialization error for session ${sessionId}:`, error);
      this.isConnected.set(sessionId, false);
      this.qrCodes.delete(sessionId);
      if (this.io) {
        this.io.emit('whatsapp:error', { sessionId, error: error.message });
      }
      
      if (this.clients.has(sessionId)) {
        try {
          const client = this.clients.get(sessionId);
          if (client) {
            await client.destroy();
          }
        } catch (destroyError) {
          logger.error('Error destroying client:', destroyError);
        }
        this.clients.delete(sessionId);
      }
      
      setTimeout(() => this.initialize(sessionId), 15000);
    } finally {
      this.isInitializing.delete(sessionId);
    }
  }

  // פונקציה חדשה להגדרת מנגנון שמירת החיבור
  setupKeepAlive(sessionId, client) {
    // מנקה interval קודם אם קיים
    if (this.keepAliveIntervals.has(sessionId)) {
      clearInterval(this.keepAliveIntervals.get(sessionId));
    }

    // מגדיר בדיקה כל 5 דקות במקום 30
    const interval = setInterval(async () => {
      try {
        // בדיקת מצב החיבור
        const state = await client.getState().catch(() => null);
        logger.debug(`Keep-alive check for session ${sessionId}: ${state}`);

        if (!state || state !== 'CONNECTED' || !this.isConnected.get(sessionId)) {
          logger.warn(`Connection issue detected for session ${sessionId}, state: ${state}`);
          
          try {
            // נסיון ראשון - איפוס מצב
            await client.resetState().catch(() => null);
            
            // בדיקה נוספת אחרי האיפוס
            const newState = await client.getState().catch(() => null);
            
            if (newState !== 'CONNECTED') {
              logger.warn(`Reset didn't help, trying full reinitialization for session ${sessionId}`);
              
              // שמירת המידע הקיים
              const existingAutoReply = this.autoReplyEnabled.get(sessionId);
              
              // ניקוי מלא
              await this.cleanupAuthFolder(sessionId);
              
              // אתחול מחדש
              await this.initialize(sessionId);
              
              // שחזור המידע
              if (existingAutoReply) {
                this.autoReplyEnabled.set(sessionId, existingAutoReply);
              }
            } else {
              logger.info(`Successfully restored connection for session ${sessionId}`);
              this.isConnected.set(sessionId, true);
            }
          } catch (reinitError) {
            logger.error(`Failed to reinitialize session ${sessionId}:`, reinitError);
            
            // במקרה של כישלון מוחלט - ננסה שוב בעוד דקה
            setTimeout(async () => {
              try {
                await this.cleanupAuthFolder(sessionId);
                await this.initialize(sessionId);
              } catch (finalError) {
                logger.error(`Final reinitialization attempt failed for session ${sessionId}:`, finalError);
              }
            }, 60000);
          }
        } else {
          // אם החיבור תקין, נבצע פעולת ping קלה
          try {
            await client.sendPresenceAvailable();
            logger.debug(`Keep-alive ping successful for session ${sessionId}`);
          } catch (pingError) {
            logger.warn(`Keep-alive ping failed for session ${sessionId}:`, pingError);
          }
        }
      } catch (error) {
        logger.error(`Keep-alive check failed for session ${sessionId}:`, error);
      }
    }, 5 * 60 * 1000); // בדיקה כל 5 דקות

    this.keepAliveIntervals.set(sessionId, interval);
    logger.info(`Keep-alive mechanism set up for session ${sessionId}`);
  }

  async getEventIdForNumber(phoneNumber) {
    try {
      const db = admin.firestore();
      const numberDoc = await db.collection('phoneNumbers')
                               .where('number', '==', phoneNumber)
                               .get();
      
      if (!numberDoc.empty) {
        return numberDoc.docs[0].data().eventId;
      }
      return null;
    } catch (error) {
      logger.error('Error getting event ID:', error);
      return null;
    }
  }

  async sendMessage(sessionId, to, message) {
    try {
      logger.info(`Starting sendMessage for session ${sessionId}:`, { to, message });
      
      if (!this.isConnected.get(sessionId)) {
        logger.error(`WhatsApp client is not connected for session ${sessionId}`);
        throw new Error('WhatsApp client is not connected');
      }

      const client = this.clients.get(sessionId);
      if (!client) {
        throw new Error('WhatsApp client not found');
      }

      if (!to || !message) {
        logger.error('Missing required fields:', { to, message });
        throw new Error('Phone number and message are required');
      }

      const cleanPhone = to.replace(/[^\d+]/g, '');
      if (!cleanPhone) {
        logger.error('Invalid phone number after cleaning:', to);
        throw new Error('Phone number must contain digits');
      }

      try {
        const formattedNumber = this.formatPhoneNumber(cleanPhone);
        logger.info('Formatted phone number:', formattedNumber);
        
        const chatId = `${formattedNumber}@c.us`;
        logger.info('Attempting to send message to:', chatId);
        
        const chat = await client.getChatById(chatId);
        if (!chat) {
          throw new Error('Chat not found for this number');
        }

        await chat.sendMessage(message);
        logger.info('Message sent successfully to:', formattedNumber);
        
        return {
          success: true,
          phoneNumber: formattedNumber,
          message: message,
          chatId: chatId
        };
      } catch (error) {
        logger.error('Error in sendMessage:', error);
        throw new Error(`Failed to send message: ${error.message}`);
      }
    } catch (error) {
      logger.error(`Top level error in sendMessage for session ${sessionId}:`, error);
      throw error;
    }
  }

  formatPhoneNumber(phoneNumber) {
    logger.debug('Formatting phone number:', phoneNumber);
    const formatted = phoneNumber.startsWith('+')
      ? phoneNumber.slice(1)
      : `972${phoneNumber.startsWith('0') ? phoneNumber.slice(1) : phoneNumber}`;
    logger.debug('Formatted result:', formatted);
    return formatted;
  }

  async archiveChat(sessionId, chatId) {
    try {
      logger.info(`Attempting to archive chat ${chatId} for session ${sessionId}`);
      
      if (!this.isConnected.get(sessionId)) {
        throw new Error('WhatsApp client is not connected');
      }

      const client = this.clients.get(sessionId);
      if (!client) {
        throw new Error('WhatsApp client not found');
      }

      const chat = await client.getChatById(chatId);
      if (!chat) {
        throw new Error('Chat not found');
      }

      await chat.archive();
      logger.info(`Chat ${chatId} archived successfully`);
      
      return true;
    } catch (error) {
      logger.error(`Error archiving chat ${chatId}:`, error);
      throw error;
    }
  }

  async processCsvFile(filePath) {
    const results = [];
    const errors = [];

    return new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', async (row) => {
          try {
            const message = row.message.replace('{name}', row.name || '');
            await this.sendMessage(row.phone, message);
            results.push({
              phone: row.phone,
              status: 'success'
            });
          } catch (error) {
            errors.push({
              phone: row.phone,
              error: error.message
            });
          }
        })
        .on('end', () => {
          resolve({
            success: results,
            errors: errors
          });
        })
        .on('error', (error) => {
          reject(error);
        });
    });
  }

  getStatus(sessionId) {
    return {
      connected: this.isConnected.get(sessionId) || false,
      hasQR: this.qrCodes.has(sessionId)
    };
  }

  // קבלת רשימת הקבוצות
  async getGroups(sessionId) {
    try {
      logger.info(`Getting groups for session ${sessionId}`);
      
      const client = this.clients.get(sessionId);
      if (!client) {
        throw new Error('WhatsApp client not found');
      }

      // קבלת כל הצ'אטים
      const chats = await client.getChats();
      logger.info(`Found ${chats.length} total chats`);
      
      // סינון קבוצות
      const groups = chats.filter(chat => chat.id._serialized.includes('@g.us'));
      logger.info(`Found ${groups.length} groups after filtering`);

      // המרה למבנה הנדרש
      const formattedGroups = await Promise.all(groups.map(async group => {
        try {
          // נסיון לקבל מידע על הקבוצה
          let participantsCount = 0;
          let groupDesc = '';
          let createdAt = null;
          
          try {
            const metadata = await group.groupMetadata;
            if (metadata) {
              participantsCount = metadata.participants?.length || 0;
              groupDesc = metadata.desc || '';
              createdAt = metadata.creation ? new Date(metadata.creation * 1000) : null;
              logger.debug(`Got ${participantsCount} participants from metadata for group ${group.name}`);
            }
          } catch (metadataError) {
            logger.warn(`Failed to get metadata for group ${group.name}:`, metadataError);
            
            // נסיון נוסף - שימוש ישיר במשתתפים
            try {
              const rawParticipants = group._data?.participants || group.participants || [];
              participantsCount = rawParticipants.length;
              logger.debug(`Got ${participantsCount} participants directly for group ${group.name}`);
            } catch (participantsError) {
              logger.warn(`Failed to get participants for group ${group.name}:`, participantsError);
            }
          }

          return {
            id: group.id._serialized,
            name: group.name || 'קבוצה ללא שם',
            participantsCount: participantsCount,
            description: groupDesc,
            isReadOnly: group.isReadOnly || false,
            createdAt: createdAt
          };
        } catch (error) {
          logger.error(`Error processing group ${group.name}:`, error);
          return {
            id: group.id._serialized,
            name: group.name || 'קבוצה ללא שם',
            participantsCount: 0,
            description: '',
            isReadOnly: false,
            createdAt: null
          };
        }
      }));

      logger.info(`Returning ${formattedGroups.length} formatted groups`);
      return formattedGroups;
    } catch (error) {
      logger.error(`Error getting groups for session ${sessionId}:`, error);
      throw error;
    }
  }

  // קבלת פרטי קבוצה ספציפית
  async getGroupDetails(sessionId, groupId) {
    try {
      logger.info(`Getting details for group ${groupId} in session ${sessionId}`);
      
      const client = this.clients.get(sessionId);
      if (!client) {
        throw new Error('WhatsApp client not found');
      }

      // קבלת הצ'אט הספציפי
      const chat = await client.getChatById(groupId);
      if (!chat) {
        logger.warn(`Group ${groupId} not found`);
        throw new Error('Group not found');
      }

      // וידוא שזו קבוצה
      if (!chat.id._serialized.includes('@g.us')) {
        logger.warn(`Chat ${groupId} is not a group`);
        throw new Error('Not a group chat');
      }

      let groupName = chat.name || 'קבוצה ללא שם';
      let groupDesc = '';
      let groupCreatedAt = null;
      let participants = [];
      let isReadOnly = chat.isReadOnly || false;

      // נסיון לקבל מידע על הקבוצה דרך הממשק הפנימי
      try {
        logger.info('Attempting to get group info through internal interface...');
        const rawChat = await client.pupPage.evaluate(async (groupId) => {
          try {
            // @ts-ignore
            const Store = window.Store || window.WhatsApp;
            const chat = Store.Chat.get(groupId);
            const metadata = await Store.GroupMetadata.find(groupId);
            
            return {
              name: chat.name,
              desc: metadata?.desc,
              creation: metadata?.creation,
              participants: metadata?.participants.getModelsArray().map(p => ({
                id: p.id._serialized,
                isAdmin: p.isAdmin
              }))
            };
          } catch (e) {
            return null;
          }
        }, groupId);

        if (rawChat) {
          logger.info('Successfully got group info through internal interface');
          groupName = rawChat.name || groupName;
          groupDesc = rawChat.desc || '';
          groupCreatedAt = rawChat.creation ? new Date(rawChat.creation * 1000).toISOString() : null;
          
          if (rawChat.participants && Array.isArray(rawChat.participants)) {
            participants = rawChat.participants.map(p => ({
              id: p.id.split('@')[0],
              isAdmin: p.isAdmin || false
            }));
            logger.info(`Found ${participants.length} participants through internal interface`);
          }
        }
      } catch (internalError) {
        logger.warn(`Failed to get info through internal interface: ${internalError.message}`);
      }

      // אם לא הצלחנו לקבל משתתפים, ננסה דרך הממשק הרגיל
      if (participants.length === 0) {
        try {
          logger.info('Attempting to get participants through regular interface...');
          const metadata = await chat.groupMetadata;
          
          if (metadata && metadata.participants) {
            participants = metadata.participants.map(p => ({
              id: p.id.user,
              isAdmin: p.isAdmin || false
            }));
            logger.info(`Found ${participants.length} participants through regular interface`);
          }
        } catch (metadataError) {
          logger.warn(`Failed to get metadata through regular interface: ${metadataError.message}`);
        }
      }

      // נסיון אחרון - שימוש בפונקציית עזר
      if (participants.length === 0) {
        try {
          logger.info('Attempting final method to get participants...');
          const rawData = await client.pupPage.evaluate(async (groupId) => {
            try {
              // @ts-ignore
              const Store = window.Store || window.WhatsApp;
              const wid = Store.WidFactory.createWid(groupId);
              const group = await Store.GroupMetadata.find(wid);
              return group ? {
                participants: group.participants.getModelsArray().map(p => ({
                  id: p.id._serialized,
                  isAdmin: p.isAdmin
                }))
              } : null;
            } catch (e) {
              return null;
            }
          }, groupId);

          if (rawData && Array.isArray(rawData.participants)) {
            participants = rawData.participants.map(p => ({
              id: p.id.split('@')[0],
              isAdmin: p.isAdmin || false
            }));
            logger.info(`Found ${participants.length} participants through final method`);
          }
        } catch (finalError) {
          logger.warn(`Failed to get participants through final method: ${finalError.message}`);
        }
      }

      // סינון כפילויות ומזהים לא תקינים
      participants = participants
        .filter(p => p.id && p.id !== 'unknown' && p.id !== '')
        .filter((p, index, self) => 
          index === self.findIndex(t => t.id === p.id)
        );

      logger.info(`Final participants count: ${participants.length}`);
      
      if (participants.length === 0) {
        logger.warn(`No participants found for group ${groupId}`);
      }

      return {
        id: chat.id._serialized,
        name: groupName,
        participantsCount: participants.length,
        description: groupDesc,
        createdAt: groupCreatedAt,
        isReadOnly: isReadOnly,
        participants: participants,
        isConnected: true,
        error: null
      };
    } catch (error) {
      logger.error(`Error getting group details for ${groupId}:`, error);
      throw error;
    }
  }

  async handleIncomingMessage(sessionId, message, from) {
    try {
      // בדיקה אם מענה אוטומטי מופעל עבור המשתמש הזה
      const autoReplyInfo = this.autoReplyEnabled.get(sessionId);
      if (!autoReplyInfo) {
        logger.info(`Auto-reply is not enabled for session ${sessionId}`);
        return;
      }

      logger.info(`Auto-reply info for session ${sessionId}:`, autoReplyInfo);

      // שליחת ההודעה ל-Rasa וקבלת תשובה
      const phoneNumber = from.split('@')[0].replace('972', '');
      logger.info(`Sending message to Rasa for ${phoneNumber}: ${message}`);
      
      const responses = await rasaService.sendMessage(message, phoneNumber);
      logger.info(`Received responses from Rasa:`, responses);
      
      // קבלת פרטי האירוע והנציג לפני שליחת התשובות
      const eventDetails = await this.getEventDetails(autoReplyInfo.eventId);
      const agentDetails = await this.getAgentDetails(autoReplyInfo.agentId);
      
      logger.info(`Event details:`, eventDetails);
      logger.info(`Agent details:`, agentDetails);
      
      // שליחת כל התשובות בחזרה למשתמש
      for (const response of responses) {
        if (response.text) {
          const formattedResponse = response.text
            .replace('{agent_name}', agentDetails.name)
            .replace('{event_name}', eventDetails.eventName)
            .replace('{event_date}', eventDetails.eventDate)
            .replace('{event_info}', eventDetails.eventInfo || '')
            .replace('{event_link}', eventDetails.eventLink || 'לא צוין')
            .replace('{price}', eventDetails.customFields?.price || 'לא צוין')
            .replace('{discount_info}', eventDetails.customFields?.discountInfo || 'אין מידע על הנחות')
            // מיקום ופרטי מקום
            .replace('{location}', eventDetails.customFields?.location || 'לא צוין')
            .replace('{venue_name}', eventDetails.customFields?.venueName || 'לא צוין')
            .replace('{address}', eventDetails.customFields?.address || 'לא צוין')
            .replace('{parking_info}', eventDetails.customFields?.parkingInfo || 'אין מידע על חניה')
            .replace('{accessibility}', eventDetails.customFields?.accessibility || 'אין מידע על נגישות')
            // גילאים ומגבלות
            .replace('{age_restriction}', eventDetails.customFields?.ageRestriction || 'אין הגבלת גיל')
            .replace('{min_age}', eventDetails.customFields?.minAge || 'לא צוין')
            .replace('{max_age}', eventDetails.customFields?.maxAge || '')
            // כרטיסים ומחירים
            .replace('{ticket_types}', eventDetails.customFields?.ticketTypes || 'לא צוין')
            .replace('{vip_price}', eventDetails.customFields?.vipPrice || 'לא צוין')
            .replace('{regular_price}', eventDetails.customFields?.regularPrice || 'לא צוין')
            .replace('{student_price}', eventDetails.customFields?.studentPrice || 'לא צוין')
            .replace('{group_discount}', eventDetails.customFields?.groupDiscount || 'אין הנחת קבוצות')
            .replace('{early_bird_price}', eventDetails.customFields?.earlyBirdPrice || 'לא צוין')
            .replace('{last_minute_price}', eventDetails.customFields?.lastMinutePrice || 'לא צוין')
            // זמנים
            .replace('{start_time}', eventDetails.customFields?.startTime || 'לא צוין')
            .replace('{end_time}', eventDetails.customFields?.endTime || 'לא צוין')
            .replace('{doors_open}', eventDetails.customFields?.doorsOpen || 'לא צוין')
            // תוכן ומידע נוסף
            .replace('{performers}', eventDetails.customFields?.performers || 'לא צוין')
            .replace('{special_guests}', eventDetails.customFields?.specialGuests || 'לא צוין')
            .replace('{program}', eventDetails.customFields?.program || 'אין מידע על התוכנית')
            .replace('{dress_code}', eventDetails.customFields?.dressCode || 'אין קוד לבוש מיוחד')
            .replace('{food_drinks}', eventDetails.customFields?.foodDrinks || 'אין מידע על אוכל ושתייה')
            .replace('{kosher_info}', eventDetails.customFields?.kosherInfo || 'אין מידע על כשרות')
            // הנחות ומבצעים
            .replace('{family_discount}', eventDetails.customFields?.familyDiscount || 'אין הנחת משפחה')
            .replace('{military_discount}', eventDetails.customFields?.militaryDiscount || 'אין הנחת חיילים')
            .replace('{senior_discount}', eventDetails.customFields?.seniorDiscount || 'אין הנחת גיל הזהב')
            .replace('{student_discount}', eventDetails.customFields?.studentDiscount || 'אין הנחת סטודנט')
            .replace('{member_discount}', eventDetails.customFields?.memberDiscount || 'אין הנחת מנוי')
            // פרטים טכניים
            .replace('{capacity}', eventDetails.customFields?.capacity || 'לא צוין')
            .replace('{seating_type}', eventDetails.customFields?.seatingType || 'לא צוין')
            .replace('{sound_system}', eventDetails.customFields?.soundSystem || 'לא צוין')
            .replace('{stage_info}', eventDetails.customFields?.stageInfo || 'לא צוין')
            // מידע ארגוני
            .replace('{organizer}', eventDetails.customFields?.organizer || 'לא צוין')
            .replace('{contact_person}', eventDetails.customFields?.contactPerson || 'לא צוין')
            .replace('{contact_phone}', eventDetails.customFields?.contactPhone || 'לא צוין')
            .replace('{contact_email}', eventDetails.customFields?.contactEmail || 'לא צוין')
            // תנאים והגבלות
            .replace('{cancellation_policy}', eventDetails.customFields?.cancellationPolicy || 'אין מידע על מדיניות ביטולים')
            .replace('{refund_policy}', eventDetails.customFields?.refundPolicy || 'אין מידע על מדיניות החזרים')
            .replace('{terms_conditions}', eventDetails.customFields?.termsConditions || 'אין מידע על תנאים והגבלות')
            // שונות
            .replace('{photography_policy}', eventDetails.customFields?.photographyPolicy || 'אין מידע על מדיניות צילום')
            .replace('{recording_policy}', eventDetails.customFields?.recordingPolicy || 'אין מידע על מדיניות הקלטה')
            .replace('{social_media}', eventDetails.customFields?.socialMedia || 'אין מידע על רשתות חברתיות')
            .replace('{hashtags}', eventDetails.customFields?.hashtags || 'אין האשטגים')
            .replace('{sponsors}', eventDetails.customFields?.sponsors || 'אין ספונסרים')
            .replace('{partners}', eventDetails.customFields?.partners || 'אין שותפים');
          
          logger.info(`Formatted response: ${formattedResponse}`);
          await this.sendMessage(sessionId, from, formattedResponse);
        }
      }
    } catch (error) {
      logger.error('Error handling incoming message:', error);
    }
  }

  async enableAutoReply(sessionId, eventId, agentId) {
    try {
      this.autoReplyEnabled.set(sessionId, { eventId, agentId });
      return true;
    } catch (error) {
      logger.error('Error enabling auto-reply:', error);
      return false;
    }
  }

  async disableAutoReply(sessionId) {
    try {
      this.autoReplyEnabled.delete(sessionId);
      return true;
    } catch (error) {
      logger.error('Error disabling auto-reply:', error);
      return false;
    }
  }

  async getAgentDetails(agentId) {
    try {
      logger.info(`Getting agent details for ${agentId}`);
      const agentRef = admin.firestore().collection('virtual_agents').doc(agentId);
      logger.info(`Agent reference path: ${agentRef.path}`);
      
      const agentDoc = await agentRef.get();
      logger.info(`Agent document exists: ${agentDoc.exists}`);
      
      if (agentDoc.exists) {
        const agentData = agentDoc.data();
        logger.info(`Found agent details:`, JSON.stringify(agentData, null, 2));
        return agentData;
      }
      logger.warn(`Agent ${agentId} not found in path ${agentRef.path}`);
      return {
        name: 'הנציג הווירטואלי',
        id: agentId
      };
    } catch (error) {
      logger.error('Error getting agent details:', error);
      logger.error('Error stack:', error.stack);
      return {
        name: 'הנציג הווירטואלי',
        id: agentId
      };
    }
  }

  async getEventDetails(eventId) {
    try {
      logger.info(`Getting event details for ${eventId}`);
      const eventRef = admin.firestore().collection('events').doc(eventId);
      logger.info(`Event reference path: ${eventRef.path}`);
      
      const eventDoc = await eventRef.get();
      logger.info(`Event document exists: ${eventDoc.exists}`);
      
      if (eventDoc.exists) {
        const eventData = eventDoc.data();
        logger.info(`Raw event data:`, JSON.stringify(eventData, null, 2));
        
        // עיבוד התאריך לפורמט מתאים בעברית
        const eventDate = eventData.eventDate ? new Date(eventData.eventDate) : null;
        const formattedDate = eventDate ? new Intl.DateTimeFormat('he-IL', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }).format(eventDate) : 'לא צוין';

        // בניית אובייקט המידע המעובד
        const formattedEventData = {
          eventName: eventData.eventName || 'האירוע',
          eventDate: formattedDate,
          eventInfo: eventData.eventInfo || '',
          eventLink: eventData.eventLink || '',
          customFields: {
            // מידע בסיסי
            price: eventData.price || eventData.customFields?.price || 'לא צוין',
            discountInfo: eventData.discountInfo || eventData.customFields?.discountInfo || '',
            location: eventData.location || eventData.customFields?.location || 'לא צוין',
            venueName: eventData.venueName || eventData.customFields?.venueName || 'לא צוין',
            address: eventData.address || eventData.customFields?.address || 'לא צוין',
            
            // זמנים
            startTime: eventData.startTime || eventData.customFields?.startTime || 'לא צוין',
            endTime: eventData.endTime || eventData.customFields?.endTime || 'לא צוין',
            doorsOpen: eventData.doorsOpen || eventData.customFields?.doorsOpen || 'לא צוין',
            
            // מידע נוסף
            performers: eventData.performers || eventData.customFields?.performers || 'לא צוין',
            specialGuests: eventData.specialGuests || eventData.customFields?.specialGuests || 'לא צוין',
            program: eventData.program || eventData.customFields?.program || eventData.eventInfo || 'אין מידע על התוכנית',
            
            // שאר השדות נשארים כפי שהם
            ...eventData.customFields
          }
        };
        
        logger.info(`Formatted event data:`, JSON.stringify(formattedEventData, null, 2));
        return formattedEventData;
      }
      
      logger.warn(`Event ${eventId} not found in path ${eventRef.path}`);
      return {
        eventName: 'האירוע',
        eventDate: 'לא צוין',
        eventInfo: '',
        eventLink: '',
        customFields: {
          price: 'לא צוין',
          discountInfo: ''
        }
      };
    } catch (error) {
      logger.error('Error getting event details:', error);
      logger.error('Error stack:', error.stack);
      return {
        eventName: 'האירוע',
        eventDate: 'לא צוין',
        eventInfo: '',
        eventLink: '',
        customFields: {
          price: 'לא צוין',
          discountInfo: ''
        }
      };
    }
  }
}

module.exports = new WhatsAppService(); 