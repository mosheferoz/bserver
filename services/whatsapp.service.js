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
    if (this.isInitializing.get(sessionId)) {
      logger.info(`WhatsApp client is already initializing for session ${sessionId}`);
      return;
    }

    try {
      this.isInitializing.set(sessionId, true);
      this.isConnected.set(sessionId, false);
      logger.info(`Starting WhatsApp client initialization for session ${sessionId}...`);

      await this.cleanupAuthFolder(sessionId);
      const sessionPath = path.join(this.authPath, `session-${sessionId}`);

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
          if (this.clients.has(sessionId)) {
            await this.clients.get(sessionId).destroy();
            this.clients.delete(sessionId);
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
          
          await this.cleanupAuthFolder(sessionId);
          
          setTimeout(() => {
            if (!this.isInitializing.get(sessionId)) {
              this.initialize(sessionId);
            }
          }, 5000);
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
          await this.clients.get(sessionId).destroy();
        } catch (destroyError) {
          logger.error('Error destroying client:', destroyError);
        }
        this.clients.delete(sessionId);
      }
      
      setTimeout(() => this.initialize(sessionId), 10000);
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
}

module.exports = new WhatsAppService(); 