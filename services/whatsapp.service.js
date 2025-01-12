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
    this.reconnectAttempts = new Map();
    this.maxReconnectAttempts = 3;
    this.cleanupInterval = setInterval(() => this.cleanupDisconnectedSessions(), 1000 * 60 * 5); // כל 5 דקות
  }

  async createClient(sessionId) {
    logger.info(`Creating new WhatsApp client for session ${sessionId}`);
    
    const sessionPath = path.join(this.authPath, `session-${sessionId}`);
    await fs.ensureDir(sessionPath);

    const client = new Client({
      restartOnAuthFail: true,
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: sessionPath
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

    try {
      await client.initialize();
      logger.info(`WhatsApp client initialized successfully for session ${sessionId}`);
      return client;
    } catch (error) {
      logger.error(`Error initializing WhatsApp client for session ${sessionId}:`, error);
      throw error;
    }
  }

  async cleanupAuthFolder(sessionId) {
    try {
      logger.info(`Starting auth folder cleanup for session ${sessionId}...`);
      const sessionPath = path.join(this.authPath, `session-${sessionId}`);

      // ניקוי הקליינט הקיים
      if (this.clients.has(sessionId)) {
        const client = this.clients.get(sessionId);
        if (client) {
          try {
            // ניסיון להתנתק בצורה מסודרת
            await client.logout().catch(err => {
              logger.warn(`Logout failed for session ${sessionId}:`, err);
            });
            
            await client.destroy().catch(err => {
              logger.warn(`Destroy failed for session ${sessionId}:`, err);
            });
            
            this.clients.delete(sessionId);
            logger.info(`Client destroyed for session ${sessionId}`);
          } catch (err) {
            logger.warn(`Error during client cleanup for session ${sessionId}:`, err);
          }
        }
      }

      // המתנה קצרה לפני ניקוי הקבצים
      await new Promise(resolve => setTimeout(resolve, 2000));

      // ניקוי תיקיות בצורה רקורסיבית
      if (await fs.pathExists(sessionPath)) {
        try {
          // קודם ננקה קבצים בודדים
          const cleanFiles = async (dir) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              try {
                if (entry.isDirectory()) {
                  await cleanFiles(fullPath);
                  await fs.rmdir(fullPath).catch(() => {});
                } else {
                  await fs.unlink(fullPath).catch(() => {});
                }
              } catch (err) {
                logger.warn(`Failed to remove ${fullPath}:`, err);
              }
            }
          };

          await cleanFiles(sessionPath);
          
          // ניסיון למחוק את התיקייה הראשית
          await fs.rm(sessionPath, { 
            force: true, 
            recursive: true,
            maxRetries: 5,
            retryDelay: 1000
          }).catch(err => {
            logger.warn(`Failed to remove main session directory ${sessionPath}:`, err);
          });
        } catch (err) {
          logger.warn(`Error during recursive cleanup of ${sessionPath}:`, err);
        }
      }

      // יצירת תיקייה חדשה נקייה
      await fs.ensureDir(sessionPath);
      logger.info(`Auth folder cleanup completed for session ${sessionId}`);
    } catch (error) {
      logger.error(`Error in cleanupAuthFolder for session ${sessionId}:`, error);
      // לא נזרוק שגיאה - נמשיך הלאה
    }
  }

  async initialize(sessionId) {
    try {
      logger.info(`Initializing WhatsApp client for session ${sessionId}`);
      
      // בדיקה אם כבר קיים קליינט פעיל
      if (this.clients.has(sessionId)) {
        const existingClient = this.clients.get(sessionId);
        if (existingClient && this.isConnected.get(sessionId)) {
          logger.info(`Client already exists and connected for session ${sessionId}`);
          return;
        }
        // אם קיים קליינט אבל לא מחובר, ננקה אותו
        await this.cleanup(sessionId);
      }

      const client = await this.createClient(sessionId);
      this.clients.set(sessionId, client);
      this.isConnected.set(sessionId, false);
      this.reconnectAttempts.set(sessionId, 0);

      // הגדרת מאזינים לאירועים
      this.setupEventListeners(client, sessionId);

      return client;
    } catch (error) {
      logger.error(`Error initializing WhatsApp client for session ${sessionId}:`, error);
      throw error;
    }
  }

  setupEventListeners(client, sessionId) {
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

    client.on('ready', () => {
      logger.info(`WhatsApp client is ready for session ${sessionId}`);
      this.isConnected.set(sessionId, true);
      this.reconnectAttempts.set(sessionId, 0);
      this.qrCodes.delete(sessionId);
    });

    client.on('disconnected', async (reason) => {
      logger.error(`WhatsApp client disconnected for session ${sessionId}:`, reason);
      this.isConnected.set(sessionId, false);
      this.qrCodes.delete(sessionId);

      // ניסיון להתחבר מחדש
      const attempts = this.reconnectAttempts.get(sessionId) || 0;
      if (attempts < this.maxReconnectAttempts) {
        logger.info(`Attempting to reconnect (${attempts + 1}/${this.maxReconnectAttempts}) for session ${sessionId}`);
        this.reconnectAttempts.set(sessionId, attempts + 1);
        
        try {
          await this.cleanup(sessionId);
          // המתנה קצרה לפני ניסיון התחברות מחדש
          await new Promise(resolve => setTimeout(resolve, 5000));
          await this.initialize(sessionId);
        } catch (error) {
          logger.error(`Failed to reconnect for session ${sessionId}:`, error);
          // אם נכשל, ננסה שוב אחרי זמן קצר
          setTimeout(async () => {
            try {
              await this.initialize(sessionId);
            } catch (retryError) {
              logger.error(`Retry reconnection failed for session ${sessionId}:`, retryError);
            }
          }, 10000);
        }
      } else {
        logger.warn(`Max reconnection attempts reached for session ${sessionId}`);
        await this.cleanup(sessionId);
      }
    });

    // הוספת מאזין חדש לניתוק מהטלפון
    client.on('auth_failure', async (error) => {
      logger.error(`Authentication failed for session ${sessionId}:`, error);
      this.isConnected.set(sessionId, false);
      this.qrCodes.delete(sessionId);
      
      // ניקוי מיידי במקרה של ניתוק מהטלפון
      await this.cleanup(sessionId);
      
      // המתנה קצרה ואז ניסיון התחברות מחדש
      setTimeout(async () => {
        try {
          await this.initialize(sessionId);
        } catch (initError) {
          logger.error(`Failed to reinitialize after auth failure for session ${sessionId}:`, initError);
        }
      }, 5000);
    });

    client.on('change_state', async (state) => {
      logger.info(`State changed to ${state} for session ${sessionId}`);
      if (state === 'UNPAIRED' || state === 'CONFLICT' || state === 'UNLAUNCHED') {
        logger.warn(`Critical state change detected: ${state}`);
        await this.handleStateChange(sessionId, state);
      }
    });

    client.on('error', async (error) => {
      logger.error(`Error in WhatsApp client for session ${sessionId}:`, error);
      if (error.message.includes('browser disconnected') || 
          error.message.includes('Target closed') ||
          error.message.includes('ENOTEMPTY')) {
        await this.handleBrowserDisconnection(sessionId);
      }
    });
  }

  async handleStateChange(sessionId, state) {
    logger.info(`Handling state change ${state} for session ${sessionId}`);
    try {
      await this.cleanup(sessionId);
      
      if (state !== 'UNLAUNCHED') {
        setTimeout(async () => {
          try {
            await this.initialize(sessionId);
          } catch (error) {
            logger.error(`Failed to reinitialize after state change for session ${sessionId}:`, error);
          }
        }, 5000);
      }
    } catch (error) {
      logger.error(`Error handling state change for session ${sessionId}:`, error);
    }
  }

  async handleBrowserDisconnection(sessionId) {
    logger.info(`Handling browser disconnection for session ${sessionId}`);
    try {
      const attempts = this.reconnectAttempts.get(sessionId) || 0;
      if (attempts < this.maxReconnectAttempts) {
        this.reconnectAttempts.set(sessionId, attempts + 1);
        await this.cleanup(sessionId);
        await this.initialize(sessionId);
      } else {
        logger.warn(`Max reconnection attempts reached after browser disconnection for session ${sessionId}`);
        await this.cleanup(sessionId);
      }
    } catch (error) {
      logger.error(`Error handling browser disconnection for session ${sessionId}:`, error);
    }
  }

  async cleanup(sessionId) {
    logger.info(`Starting cleanup for session ${sessionId}...`);
    try {
      // ניקוי נתונים מהזיכרון
      this.qrCodes.delete(sessionId);
      this.isConnected.set(sessionId, false);
      
      // ניקוי הקליינט והתיקיות
      await this.cleanupAuthFolder(sessionId);
      
      // איפוס ניסיונות התחברות מחדש
      this.reconnectAttempts.delete(sessionId);
      
      logger.info(`Cleanup completed for session ${sessionId}`);
    } catch (error) {
      logger.error(`Error during cleanup for session ${sessionId}:`, error);
    }
  }

  async cleanupDisconnectedSessions() {
    try {
      for (const [sessionId, isConnected] of this.isConnected.entries()) {
        if (!isConnected) {
          const attempts = this.reconnectAttempts.get(sessionId) || 0;
          if (attempts >= this.maxReconnectAttempts) {
            logger.info(`Cleaning up disconnected session ${sessionId}`);
            await this.cleanup(sessionId);
          }
        }
      }
    } catch (error) {
      logger.error('Error cleaning up disconnected sessions:', error);
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

      const chat = await client.getChatById(groupId);
      if (!chat || !chat.isGroup) {
        throw new Error('Group not found');
      }

      // קבלת מטא-דאטה של הקבוצה
      const metadata = await chat.groupMetadata;
      
      return {
        id: chat.id._serialized,
        name: chat.name || 'קבוצה ללא שם',
        participantsCount: metadata?.participants?.length || 0,
        description: metadata?.desc || '',
        createdAt: metadata?.creation ? new Date(metadata.creation * 1000).toISOString() : null,
        isReadOnly: chat.isReadOnly || false,
        participants: metadata?.participants?.map(p => ({
          id: p.id._serialized,
          isAdmin: p.isAdmin || false,
        })) || [],
      };
    } catch (error) {
      logger.error(`Error getting group details for ${groupId}:`, error);
      throw error;
    }
  }
}

module.exports = new WhatsAppService(); 