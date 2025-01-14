const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const { rimraf } = require('rimraf');
const config = require('../config');
const logger = require('../logger');
const path = require('path');
const { LocalAuth } = require('whatsapp-web.js');
const csv = require('csv-parser');

class WhatsAppService {
  constructor() {
    this.clients = new Map();
    this.qrCodes = new Map();
    this.isConnected = new Map();
    this.isInitializing = new Map();
    this.authPath = path.join(__dirname, '../whatsapp-auth');
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
            // נסה לנתק בצורה מסודרת
            await client.logout().catch(err => logger.warn('Logout error:', err));
            await client.destroy().catch(err => logger.warn('Destroy error:', err));
          } catch (err) {
            logger.warn('Client cleanup error:', err);
          } finally {
            // תמיד נקה את המשאבים
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
          // נסה למחוק קודם את הקבצים הבעייתיים
          const problematicPaths = [
            path.join(sessionPath, `session-${sessionId}`, 'Default', 'IndexedDB'),
            path.join(sessionPath, `session-${sessionId}`, 'Default', 'Cache'),
            path.join(sessionPath, `session-${sessionId}`, 'Default', 'Service Worker')
          ];

          for (const dirPath of problematicPaths) {
            if (fs.existsSync(dirPath)) {
              try {
                // נסה למחוק עם rimraf
                await rimraf(dirPath, { 
                  maxRetries: 5,
                  recursive: true,
                  force: true,
                  retryDelay: 1000
                });
              } catch (err) {
                logger.warn(`Failed to remove directory ${dirPath}:`, err);
                // אם נכשל, נסה למחוק קבצים בודדים
                try {
                  const files = fs.readdirSync(dirPath);
                  for (const file of files) {
                    const filePath = path.join(dirPath, file);
                    try {
                      if (fs.lstatSync(filePath).isDirectory()) {
                        await rimraf(filePath, { maxRetries: 3, recursive: true, force: true });
                      } else {
                        fs.unlinkSync(filePath);
                      }
                    } catch (fileErr) {
                      logger.warn(`Failed to remove path ${filePath}:`, fileErr);
                    }
                  }
                } catch (readErr) {
                  logger.warn(`Failed to read directory ${dirPath}:`, readErr);
                }
              }
            }
          }

          // המתנה נוספת אחרי מחיקת הקבצים הבעייתיים
          await new Promise(resolve => setTimeout(resolve, 2000));

          // עכשיו נסה למחוק את כל התיקייה
          await rimraf(sessionPath, { 
            maxRetries: 5,
            recursive: true,
            force: true,
            retryDelay: 1000
          });
          
          logger.info('Session folder removed successfully');
        } catch (err) {
          logger.error('Error removing session folder:', err);
          // אם נכשלנו במחיקה, ננסה לפחות ליצור תיקייה נקייה
          try {
            const newSessionPath = path.join(this.authPath, `session-${sessionId}-${Date.now()}`);
            await fs.promises.mkdir(newSessionPath, { recursive: true });
            logger.info(`Created new session folder at ${newSessionPath}`);
            return newSessionPath;
          } catch (mkdirErr) {
            logger.error('Failed to create new session folder:', mkdirErr);
            throw mkdirErr;
          }
        }
      }

      // יצירת תיקייה חדשה
      try {
        await fs.promises.mkdir(sessionPath, { recursive: true });
        logger.info('Session folder recreated');
        return sessionPath;
      } catch (mkdirErr) {
        logger.error('Error creating new session folder:', mkdirErr);
        throw mkdirErr;
      }

    } catch (error) {
      logger.error('Error in cleanupAuthFolder:', error);
      throw error;
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
        logger.info(`WhatsApp client is ready and connected for session ${sessionId}`);
      });

      client.on('qr', async (qr) => {
        try {
          logger.info(`Received QR code from WhatsApp for session ${sessionId}`);
          const qrCode = await qrcode.toDataURL(qr);
          this.qrCodes.set(sessionId, qrCode);
          logger.info('QR code converted to data URL');
        } catch (error) {
          logger.error('Error generating QR code:', error);
          this.qrCodes.delete(sessionId);
        }
      });

      client.on('authenticated', () => {
        this.isConnected.set(sessionId, true);
        this.qrCodes.delete(sessionId);
        logger.info(`WhatsApp client authenticated for session ${sessionId}`);
      });

      client.on('auth_failure', async (err) => {
        this.isConnected.set(sessionId, false);
        this.qrCodes.delete(sessionId);
        logger.error(`WhatsApp authentication failed for session ${sessionId}:`, err);
        
        await this.cleanupAuthFolder(sessionId);
        setTimeout(() => this.initialize(sessionId), 5000);
      });

      client.on('disconnected', async (reason) => {
        this.isConnected.set(sessionId, false);
        this.qrCodes.delete(sessionId);
        logger.error(`WhatsApp client disconnected for session ${sessionId}:`, reason);
        
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

      await client.initialize();
      this.clients.set(sessionId, client);
      logger.info(`WhatsApp client initialized successfully for session ${sessionId}`);
    } catch (error) {
      logger.error(`WhatsApp initialization error for session ${sessionId}:`, error);
      this.isConnected.set(sessionId, false);
      this.qrCodes.delete(sessionId);
      
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

  getStatus(sessionId) {
    return {
      connected: this.isConnected.get(sessionId) || false,
      hasQR: this.qrCodes.has(sessionId)
    };
  }

  getQR(sessionId) {
    logger.debug(`getQR called for session ${sessionId}`);
    
    if (!this.clients.has(sessionId)) {
      throw new Error('WhatsApp client not initialized');
    }
    if (!this.qrCodes.has(sessionId)) {
      throw new Error('No QR code available yet. Please wait for QR generation.');
    }
    return this.qrCodes.get(sessionId);
  }

  async sendMessage(sessionId, phoneNumber, message) {
    try {
      logger.info(`Starting sendMessage for session ${sessionId}:`, { phoneNumber, message });
      
      if (!this.isConnected.get(sessionId)) {
        logger.error(`WhatsApp client is not connected for session ${sessionId}`);
        throw new Error('WhatsApp client is not connected');
      }

      const client = this.clients.get(sessionId);
      if (!client) {
        throw new Error('WhatsApp client not found');
      }

      if (!phoneNumber || !message) {
        logger.error('Missing required fields:', { phoneNumber, message });
        throw new Error('Phone number and message are required');
      }

      const cleanPhone = phoneNumber.replace(/[^\d+]/g, '');
      if (!cleanPhone) {
        logger.error('Invalid phone number after cleaning:', phoneNumber);
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

  formatPhoneNumber(phoneNumber) {
    logger.debug('Formatting phone number:', phoneNumber);
    const formatted = phoneNumber.startsWith('+')
      ? phoneNumber.slice(1)
      : `972${phoneNumber.startsWith('0') ? phoneNumber.slice(1) : phoneNumber}`;
    logger.debug('Formatted result:', formatted);
    return formatted;
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
      
      // סינון רבוצות לפי מספר מאפיינים
      const groups = chats.filter(chat => {
        const isGroup = chat.isGroup || 
                       chat.groupMetadata || 
                       (chat.id && chat.id._serialized && chat.id._serialized.includes('@g.us')) ||
                       chat.participants?.length > 2;
                       
        logger.debug(`Chat ${chat.name}: isGroup=${isGroup}, id=${chat.id?._serialized}`);
        return isGroup;
      });
      
      logger.info(`Found ${groups.length} groups after filtering`);

      // המרה למבנה הנדרש
      const formattedGroups = await Promise.all(groups.map(async group => {
        try {
          const metadata = await group.groupMetadata;
          return {
            id: group.id._serialized,
            name: group.name || metadata?.subject || 'קבוצה ללא שם',
            participantsCount: metadata?.participants?.length || group.participants?.length || 0,
            isReadOnly: group.isReadOnly || false,
          };
        } catch (error) {
          logger.error(`Error getting metadata for group ${group.name}:`, error);
          return {
            id: group.id._serialized,
            name: group.name || 'קבוצה ללא שם',
            participantsCount: group.participants?.length || 0,
            isReadOnly: group.isReadOnly || false,
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

  // פונקציה חדשה לקבלת מידע מפורט על קבוצה ספציפית
  async getGroupDetails(sessionId, groupId) {
    try {
      logger.info(`Getting details for group ${groupId} in session ${sessionId}`);
      
      const client = this.clients.get(sessionId);
      if (!client) {
        throw new Error('WhatsApp client not found');
      }

      // קבלת הצ'אט הספציפי ישירות
      const chat = await client.getChatById(groupId);
      if (!chat) {
        logger.warn(`Group ${groupId} not found`);
        throw new Error('Group not found');
      }

      // בדיקה אם זו קבוצה
      if (!chat.isGroup) {
        logger.warn(`Chat ${groupId} is not a group`);
        throw new Error('Not a group chat');
      }

      // קבלת מטא-דאטה של הקבוצה
      const metadata = await chat.groupMetadata;
      logger.info(`Got metadata for group ${groupId}`);

      // קבלת כל המשתתפים בקבוצה
      const participants = metadata.participants.map(participant => ({
        id: participant.id.user, // רק המספר, בלי ה-@c.us
        isAdmin: participant.isAdmin || participant.isSuperAdmin
      }));

      logger.info(`Got ${participants.length} participants for group ${groupId}`);
      
      return {
        id: chat.id._serialized,
        name: metadata.subject || chat.name || 'קבוצה ללא שם',
        participantsCount: participants.length,
        description: metadata.desc || '',
        createdAt: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : null,
        isReadOnly: chat.isReadOnly || false,
        participants: participants,
        isConnected: true,
        error: null
      };
    } catch (error) {
      logger.error(`Error getting group details for ${groupId}:`, error);
      throw error;
    }
  }
}

module.exports = new WhatsAppService(); 