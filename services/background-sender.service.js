const whatsappService = require('./whatsapp.service');
const logger = require('../logger');

class BackgroundSenderService {
  constructor() {
    this.activeSenders = new Map(); // numberId -> { isSending, sentCount, totalCount, lastSentIndex }
    this.sendingData = new Map(); // numberId -> { number, recipients, message, delaySeconds, shouldArchive }
    this.sendingWorkers = new Map(); // numberId -> Worker
    this.io = null;
    this.workerStats = new Map(); // numberId -> { startTime, lastUpdateTime, sendRate }
  }

  setSocketIO(io) {
    this.io = io;
    logger.info('Socket.IO set for background sender service');
  }

  // עדכון סטטוס דרך סוקט
  _emitStatus(numberId, status) {
    if (this.io) {
      this.io.emit(`background-sender:status:${numberId}`, status);
      logger.debug(`Emitted status for ${numberId}:`, status);
    }
  }

  async startSending(data) {
    try {
      const { numberId, number, recipients, message, delaySeconds, shouldArchive, whatsAppSessionId, lastSentIndex, forceStartIndex } = data;
      logger.info(`Starting background sending for ${numberId} with WhatsApp session ID: ${whatsAppSessionId}`);

      // בדיקה אם כבר יש שליחה פעילה
      if (this.sendingWorkers.has(numberId)) {
        logger.warn(`Already sending for ${numberId}`);
        return false;
      }

      // קביעת האינדקס ההתחלתי
      let startIndex = -1;
      const existingStatus = this.activeSenders.get(numberId);
      
      if (forceStartIndex) {
        startIndex = lastSentIndex;
        logger.info(`Forcing start from index: ${startIndex + 1}`);
      } else if (existingStatus && existingStatus.lastSentIndex > -1) {
        startIndex = existingStatus.lastSentIndex;
        logger.info(`Continuing from existing index: ${startIndex + 1}`);
      }

      // שמירת הנתונים
      this.sendingData.set(numberId, {
        number,
        recipients,
        message,
        delaySeconds,
        shouldArchive,
        whatsAppSessionId
      });

      // אתחול סטטוס
      const status = {
        isSending: true,
        sentCount: startIndex + 1,
        totalCount: recipients.length,
        lastSentIndex: startIndex,
        startTime: new Date(),
        estimatedTimeRemaining: null,
        sendRate: 0
      };
      
      this.activeSenders.set(numberId, status);
      this._emitStatus(numberId, status);

      // התחלת worker חדש
      this._startWorker(numberId);

      return true;
    } catch (error) {
      logger.error('Error starting background sending:', error);
      return false;
    }
  }

  _startWorker(numberId) {
    logger.info(`Starting worker for ${numberId}`);

    const worker = this._createSendingWorker(numberId);
    this.sendingWorkers.set(numberId, worker);
    
    // אתחול סטטיסטיקות
    this.workerStats.set(numberId, {
      startTime: Date.now(),
      lastUpdateTime: Date.now(),
      messagesSent: 0,
      sendRate: 0
    });
  }

  _createSendingWorker(numberId) {
    const data = this.sendingData.get(numberId);
    const status = this.activeSenders.get(numberId);
    const stats = this.workerStats.get(numberId);
    
    if (!data || !status || !stats) {
      logger.error(`No data or status found for ${numberId}`);
      return null;
    }

    const worker = {
      isRunning: true,
      stop: () => {
        worker.isRunning = false;
      }
    };

    this._processSending(numberId, worker).finally(() => {
      this._workerFinished(numberId);
    });

    return worker;
  }

  async _processSending(numberId, worker) {
    const data = this.sendingData.get(numberId);
    const status = this.activeSenders.get(numberId);
    const stats = this.workerStats.get(numberId);
    
    if (!data || !status || !stats) {
      logger.error(`Missing data for ${numberId}`);
      return;
    }

    const { recipients, message, delaySeconds, shouldArchive, whatsAppSessionId } = data;
    const startIndex = status.lastSentIndex + 1;

    try {
      for (let i = startIndex; i < recipients.length && worker.isRunning; i++) {
        const recipient = recipients[i];
        
        try {
          logger.info(`[Worker ${numberId}] Sending to ${recipient.name} (${recipient.phone})`);
          
          const sendStartTime = Date.now();
          const success = await whatsappService.sendMessage(
            whatsAppSessionId,
            recipient.phone,
            this._processMessageTemplate(message, recipient)
          );

          if (success) {
            // עדכון סטטיסטיקות
            stats.messagesSent++;
            const currentTime = Date.now();
            const timeDiff = (currentTime - stats.lastUpdateTime) / 1000; // המרה לשניות
            if (timeDiff > 0) {
              stats.sendRate = stats.messagesSent / timeDiff;
            }
            
            // עדכון סטטוס
            status.sentCount++;
            status.lastSentIndex = i;
            status.sendRate = stats.sendRate;
            
            // חישוב זמן משוער שנותר
            const remainingMessages = recipients.length - (i + 1);
            if (stats.sendRate > 0) {
              status.estimatedTimeRemaining = Math.ceil(remainingMessages / stats.sendRate);
            }
            
            this._emitStatus(numberId, status);
            
            // המתנה לפי ההשהיה שהוגדרה
            if (i < recipients.length - 1 && delaySeconds > 0) {
              await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
            }
          } else {
            logger.warn(`[Worker ${numberId}] Failed to send to ${recipient.phone}`);
            // ניסיון שליחה חוזר אחרי 5 שניות
            await new Promise(resolve => setTimeout(resolve, 5000));
            i--; // חזרה לנסות שוב את אותו נמען
          }
        } catch (error) {
          logger.error(`[Worker ${numberId}] Error sending to ${recipient.phone}:`, error);
          // המתנה קצרה במקרה של שגיאה
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    } finally {
      if (worker.isRunning) {
        status.isSending = false;
        status.estimatedTimeRemaining = 0;
        this._emitStatus(numberId, status);
      }
    }
  }

  _workerFinished(numberId) {
    this.sendingWorkers.delete(numberId);
    this.workerStats.delete(numberId);
    logger.info(`Worker for ${numberId} finished`);
  }

  async stopSending(numberId) {
    try {
      logger.info(`Stopping background sending for ${numberId}`);
      
      const worker = this.sendingWorkers.get(numberId);
      if (worker) {
        worker.stop();
        this.sendingWorkers.delete(numberId);
      }

      const status = this.activeSenders.get(numberId);
      if (status) {
        status.isSending = false;
        status.estimatedTimeRemaining = null;
        this._emitStatus(numberId, status);
      }
      
      return true;
    } catch (error) {
      logger.error('Error stopping background sending:', error);
      return false;
    }
  }

  async resetSendingState(numberId) {
    try {
      logger.info(`Resetting sending state for ${numberId}`);
      
      await this.stopSending(numberId);
      
      this.activeSenders.delete(numberId);
      this.sendingData.delete(numberId);
      this.workerStats.delete(numberId);
      
      this._emitStatus(numberId, {
        isSending: false,
        sentCount: 0,
        totalCount: 0,
        lastSentIndex: -1,
        estimatedTimeRemaining: null,
        sendRate: 0
      });
      
      return true;
    } catch (error) {
      logger.error('Error resetting sending state:', error);
      return false;
    }
  }

  getSendingStatus(numberId) {
    return this.activeSenders.get(numberId) || {
      isSending: false,
      sentCount: 0,
      totalCount: 0,
      lastSentIndex: -1,
      estimatedTimeRemaining: null,
      sendRate: 0
    };
  }

  _processMessageTemplate(template, recipient) {
    return template
      .replace('{שם}', recipient.name)
      .replace('{טלפון}', recipient.phone)
      .replace('{name}', recipient.name)
      .replace('{phone}', recipient.phone);
  }
}

module.exports = new BackgroundSenderService(); 