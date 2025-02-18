const whatsappService = require('./whatsapp.service');
const logger = require('../logger');
const admin = require('firebase-admin');

class BackgroundSenderService {
  constructor() {
    this.activeSenders = new Map(); // numberId -> { isSending, sentCount, totalCount, lastSentIndex }
    this.sendingData = new Map(); // numberId -> { number, recipients, message, delaySeconds, shouldArchive }
    this.sendingWorkers = new Map(); // numberId -> Worker
    this.userWorkers = new Map(); // userId -> Set<numberId>
    this.userPlans = new Map(); // userId -> { planId, numberLimit }
    this.io = null;
    this.sendingQueue = []; // תור לשליחות ממתינות
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

  // פונקציה חדשה לקבלת מגבלת המספרים של המשתמש
  async _getUserNumberLimit(userId) {
    try {
      // בדיקה אם יש כבר מידע בזיכרון
      if (this.userPlans.has(userId)) {
        return parseInt(this.userPlans.get(userId).numberLimit);
      }

      
      // קבלת תכנית המשתמש מ-Firestore
      const userDoc = await admin.firestore().collection('users').doc(userId).get();
      if (!userDoc.exists) {
        logger.warn(`User ${userId} not found`);
        return 1; // ברירת מחדל למקרה של שגיאה
      }

      const userData = userDoc.data();
      const planId = userData.planId ;

      // קבלת פרטי התכנית
      const planDoc = await admin.firestore().collection('plans').doc(planId).get();
      if (!planDoc.exists) {
        logger.warn(`Plan ${planId} not found`);
        return 1;
      }

      const planData = planDoc.data();
      const numberLimit = parseInt(planData.numberlimit) || 1;

      // שמירה בזיכרון
      this.userPlans.set(userId, {
        planId,
        numberLimit
      });

      return numberLimit;
    } catch (error) {
      logger.error('Error getting user number limit:', error);
      return 1; // ברירת מחדל במקרה של שגיאה
    }
  }

  // פונקציה חדשה לבדיקת מספר השליחות הפעילות של משתמש
  _getUserActiveWorkers(userId) {
    return this.userWorkers.get(userId)?.size || 0;
  }

  async startSending(data) {
    try {
      const { numberId, number, recipients, message, delaySeconds, shouldArchive, whatsAppSessionId, lastSentIndex, forceStartIndex } = data;
      const userId = number.userId;
      
      logger.info(`Starting background sending for ${numberId} (User: ${userId})`);

      // בדיקה אם כבר יש שליחה פעילה למספר זה
      if (this.sendingWorkers.has(numberId)) {
        logger.warn(`Already sending for ${numberId}`);
        return false;
      }

      // בדיקת מגבלת המספרים של המשתמש
      const numberLimit = await this._getUserNumberLimit(userId);
      const currentActive = this._getUserActiveWorkers(userId);

      logger.info(`User ${userId} has ${currentActive} active workers out of ${numberLimit} limit`);

      if (currentActive >= numberLimit) {
        logger.warn(`User ${userId} has reached their concurrent sending limit (${numberLimit})`);
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
        whatsAppSessionId,
        userId // הוספת userId לנתונים
      });

      // אתחול סטטוס
      const status = {
        isSending: true,
        sentCount: startIndex + 1,
        totalCount: recipients.length,
        lastSentIndex: startIndex
      };
      
      this.activeSenders.set(numberId, status);
      this._emitStatus(numberId, status);

      // עדכון מעקב שליחות משתמש
      if (!this.userWorkers.has(userId)) {
        this.userWorkers.set(userId, new Set());
      }
      this.userWorkers.get(userId).add(numberId);

      // התחלת worker
      this._startWorker(numberId);
      
      return true;
    } catch (error) {
      logger.error('Error starting background sending:', error);
      return false;
    }
  }

  async _startWorker(numberId) {
    const worker = this._createSendingWorker(numberId);
    this.sendingWorkers.set(numberId, worker);
  }

  _createSendingWorker(numberId) {
    const data = this.sendingData.get(numberId);
    const status = this.activeSenders.get(numberId);
    
    if (!data || !status) {
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
    
    if (!data || !status) {
      logger.error(`No data or status found for ${numberId}`);
      return;
    }

    const { recipients, message, delaySeconds, shouldArchive, whatsAppSessionId } = data;
    const startIndex = status.lastSentIndex + 1;

    try {
      for (let i = startIndex; i < recipients.length && worker.isRunning; i++) {
        const recipient = recipients[i];
        
        try {
          logger.info(`[Worker ${numberId}] Sending to ${recipient.name} (${recipient.phone})`);
          
          const success = await whatsappService.sendMessage(
            whatsAppSessionId,
            recipient.phone,
            this._processMessageTemplate(message, recipient)
          );

          if (success) {
            status.sentCount++;
            status.lastSentIndex = i;
            this._emitStatus(numberId, status);
            
            if (i < recipients.length - 1 && delaySeconds > 0) {
              await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
            }
          } else {
            logger.warn(`[Worker ${numberId}] Failed to send to ${recipient.phone}`);
            // אפשרות להוסיף לוגיקת retry כאן
          }
        } catch (error) {
          logger.error(`[Worker ${numberId}] Error sending to ${recipient.phone}:`, error);
        }
      }
    } finally {
      if (worker.isRunning) {
        status.isSending = false;
        this._emitStatus(numberId, status);
      }
    }
  }

  _workerFinished(numberId) {
    const worker = this.sendingWorkers.get(numberId);
    if (!worker) return;

    const data = this.sendingData.get(numberId);
    if (!data) return;

    const userId = data.userId;

    // הסרת העובד מהרשימות
    this.sendingWorkers.delete(numberId);
    this.userWorkers.get(userId)?.delete(numberId);

    // אם אין יותר עובדים למשתמש, מחיקת הרשומה
    if (this.userWorkers.get(userId)?.size === 0) {
      this.userWorkers.delete(userId);
    }
    
    logger.info(`Worker for ${numberId} finished. User ${userId} has ${this._getUserActiveWorkers(userId)} active workers`);

    // בדיקה אם יש שליחות בתור
    if (this.sendingQueue.length > 0) {
      const nextNumberId = this.sendingQueue.shift();
      const nextData = this.sendingData.get(nextNumberId);
      
      if (nextData) {
        // בדיקה שהמשתמש הבא לא חרג ממגבלת השליחות שלו
        this._getUserNumberLimit(nextData.userId).then(limit => {
          const userActive = this._getUserActiveWorkers(nextData.userId);
          if (userActive < limit) {
            this._startWorker(nextNumberId);
          } else {
            logger.warn(`User ${nextData.userId} has reached their limit, keeping ${nextNumberId} in queue`);
            this.sendingQueue.unshift(nextNumberId);
          }
        });
      }
    }
  }

  async stopSending(numberId) {
    try {
      logger.info(`Stopping background sending for ${numberId}`);
      
      const data = this.sendingData.get(numberId);
      if (data) {
        const userId = data.userId;
        
        // הסרה מהתור אם קיים
        const queueIndex = this.sendingQueue.indexOf(numberId);
        if (queueIndex > -1) {
          this.sendingQueue.splice(queueIndex, 1);
          logger.info(`Removed ${numberId} from queue`);
        }

        // עצירת worker אם פעיל
        const worker = this.sendingWorkers.get(numberId);
        if (worker) {
          worker.stop();
          this.sendingWorkers.delete(numberId);
          this.userWorkers.get(userId)?.delete(numberId);
          
          // אם אין יותר עובדים למשתמש, מחיקת הרשומה
          if (this.userWorkers.get(userId)?.size === 0) {
            this.userWorkers.delete(userId);
          }
        }

        // עדכון סטטוס
        const status = this.activeSenders.get(numberId);
        if (status) {
          status.isSending = false;
          this._emitStatus(numberId, status);
        }
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
      
      this._emitStatus(numberId, {
        isSending: false,
        sentCount: 0,
        totalCount: 0,
        lastSentIndex: -1
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
      lastSentIndex: -1
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