const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const { rimraf } = require('rimraf');
const config = require('../config');
const logger = require('../logger');
const path = require('path');
const { LocalAuth } = require('whatsapp-web.js');
const csv = require('csv-parser');
const EventEmitter = require('events');

class WhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map();
    this.qrCodes = new Map();
    this.isConnected = new Map();
    this.isInitializing = new Map();
    this.authPath = path.join(__dirname, '../whatsapp-auth');
    this.qrCallbacks = new Map();
    this.authFolder = path.join(__dirname, '../.wwebjs_auth');
    this.initializeEventHandlers();
  }

  initializeEventHandlers() {
    this.on('client.ready', (sessionId) => {
      logger.info(`Client ${sessionId} is ready and fully connected`);
      this.isConnected.set(sessionId, true);
    });

    this.on('client.disconnected', (sessionId) => {
      logger.info(`Client ${sessionId} was disconnected`);
      this.isConnected.set(sessionId, false);
    });
  }

  async cleanupAuthFolder(sessionId) {
    try {
      logger.info(`Starting auth folder cleanup for session ${sessionId}...`);
      const sessionPath = path.join(this.authPath, `session-${sessionId}`);

      if (this.clients.has(sessionId)) {
        try {
          await this.clients.get(sessionId).destroy();
          this.clients.delete(sessionId);
          logger.info(`Existing client destroyed for session ${sessionId}`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (err) {
          logger.warn('Error destroying client:', err);
        }
      }

      if (fs.existsSync(sessionPath)) {
        await rimraf(sessionPath, { 
          maxRetries: 3,
          recursive: true,
          force: true
        });
        logger.info('Session folder removed');
      }

      await fs.ensureDir(sessionPath);
      logger.info('Session folder recreated');

      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      logger.error('Error in cleanupAuthFolder:', error);
    }
  }

  async initialize(sessionId) {
    try {
      logger.info(`Initializing WhatsApp client for session ${sessionId}`);
      
      if (this.clients.has(sessionId)) {
        logger.info(`Client already exists for session ${sessionId}`);
        return;
      }

      const sessionDir = path.join(this.authFolder, sessionId);
      await fs.promises.mkdir(sessionDir, { recursive: true });

      const client = new Client({
        authStrategy: new LocalAuth({
          clientId: sessionId,
          dataPath: this.authFolder
        }),
        puppeteer: {
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
      });

      client.on('qr', (qr) => {
        logger.info(`Received QR code from WhatsApp for session ${sessionId}`);
        try {
          qrcode.toDataURL(qr, (err, url) => {
            if (!err) {
              this.qrCodes.set(sessionId, url);
              logger.info('QR code converted to data URL');
            }
          });
        } catch (error) {
          logger.error('Error converting QR code:', error);
        }
      });

      client.on('ready', () => {
        logger.info(`WhatsApp client is ready for session ${sessionId}`);
        this.isConnected.set(sessionId, true);
        this.emit('client.ready', sessionId);
      });

      client.on('authenticated', () => {
        logger.info(`WhatsApp client is authenticated for session ${sessionId}`);
      });

      client.on('disconnected', () => {
        logger.info(`WhatsApp client was disconnected for session ${sessionId}`);
        this.isConnected.set(sessionId, false);
        this.emit('client.disconnected', sessionId);
      });

      await client.initialize();
      this.clients.set(sessionId, client);
      
      logger.info(`WhatsApp client initialized successfully for session ${sessionId}`);
    } catch (error) {
      logger.error(`Error initializing WhatsApp client for session ${sessionId}:`, error);
      throw error;
    }
  }

  async getConnectionStatus(sessionId) {
    try {
      const client = this.clients.get(sessionId);
      if (!client) {
        return { connected: false, hasQR: false };
      }

      const isConnected = this.isConnected.get(sessionId) || false;
      return {
        connected: isConnected,
        hasQR: !isConnected
      };
    } catch (error) {
      logger.error(`Error getting connection status for session ${sessionId}:`, error);
      return { connected: false, hasQR: false };
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
      const client = this.clients.get(sessionId);
      if (!client) {
        throw new Error('Session not found');
      }

      if (!client.isConnected) {
        throw new Error('WhatsApp is not connected');
      }

      const chats = await client.getChats();
      
      const groups = chats
        .filter(chat => chat.isGroup)
        .map(group => ({
          id: group.id._serialized,
          name: group.name,
          description: group.description || '',
          participantsCount: group.participants.length,
          imageUrl: group.profilePicUrl,
          isAdmin: group.participants.some(p => 
            p.id.user === client.info.wid.user && p.isAdmin
          ),
        }));

      return groups;
    } catch (error) {
      logger.error('Error getting groups:', error);
      throw error;
    }
  }
}

module.exports = new WhatsAppService(); 