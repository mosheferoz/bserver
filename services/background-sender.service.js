const whatsappService = require('./whatsapp.service');
const logger = require('../logger');

class BackgroundSenderService {
  constructor() {
    this.activeSenders = new Map(); // numberId -> { isSending, sentCount, totalCount, lastSentIndex }
    this.sendingData = new Map(); // numberId -> { number, recipients, message, delaySeconds, shouldArchive }
    this.io = null;
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
      const { numberId, number, recipients, message, delaySeconds, shouldArchive } = data;
      logger.info(`Starting background sending for ${numberId}`);

      // שמירת הנתונים
      this.sendingData.set(numberId, {
        number,
        recipients,
        message,
        delaySeconds,
        shouldArchive
      });

      // אתחול סטטוס
      const status = {
        isSending: true,
        sentCount: 0,
        totalCount: recipients.length,
        lastSentIndex: -1
      };
      
      this.activeSenders.set(numberId, status);
      this._emitStatus(numberId, status);

      // התחלת תהליך השליחה
      this._startSendingProcess(numberId);

      return true;
    } catch (error) {
      logger.error('Error starting background sending:', error);
      return false;
    }
  }

  async stopSending(numberId) {
    try {
      logger.info(`Stopping background sending for ${numberId}`);
      
      const status = this.activeSenders.get(numberId);
      if (status) {
        status.isSending = false;
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

  async _startSendingProcess(numberId) {
    const data = this.sendingData.get(numberId);
    const status = this.activeSenders.get(numberId);
    
    if (!data || !status || !status.isSending) {
      logger.info(`Sending process stopped or no data for ${numberId}`);
      return;
    }

    try {
      const { number, recipients, message, delaySeconds, shouldArchive } = data;
      const startIndex = status.lastSentIndex + 1;

      for (let i = startIndex; i < recipients.length; i++) {
        // בדיקה האם צריך לעצור
        if (!this.activeSenders.get(numberId)?.isSending) {
          logger.info(`Sending stopped for ${numberId}`);
          break;
        }

        const recipient = recipients[i];
        try {
          logger.info(`Sending message to ${recipient.name} (${recipient.phone})`);
          
          const success = await whatsappService.sendMessage(
            number.whatsAppSessionId,
            recipient.phone,
            this._processMessageTemplate(message, recipient)
          );

          if (success) {
            status.sentCount++;
            status.lastSentIndex = i;
            
            // עדכון סטטוס דרך סוקט
            this._emitStatus(numberId, status);
            
            logger.info(`Message sent successfully (${status.sentCount}/${status.totalCount})`);

            // בדיקה האם סיימנו
            if (status.lastSentIndex >= recipients.length - 1) {
              logger.info(`Finished sending all messages for ${numberId}`);
              status.isSending = false;
              this._emitStatus(numberId, status);
              break;
            }

            // המתנה לפי ההשהיה שהוגדרה
            if (delaySeconds > 0 && i < recipients.length - 1) {
              logger.info(`Waiting ${delaySeconds} seconds before next message`);
              await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
            }
          } else {
            logger.warn(`Failed to send message to ${recipient.phone}`);
          }
        } catch (error) {
          logger.error(`Error sending message to ${recipient.phone}:`, error);
        }
      }
    } catch (error) {
      logger.error(`Error in sending process for ${numberId}:`, error);
      
      // עדכון סטטוס במקרה של שגיאה
      const status = this.activeSenders.get(numberId);
      if (status) {
        status.isSending = false;
        this._emitStatus(numberId, status);
      }
    }
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