const logger = require('../logger');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Client, MessageMedia } = require('whatsapp-web.js');

class WhatsAppGroupsService {
  constructor() {
    this.updateQueue = new Map(); // תור עדכונים לכל sessionId
    this.tempDir = path.join(__dirname, '../temp');
    // יצירת תיקיית temp אם לא קיימת
    fs.mkdir(this.tempDir, { recursive: true }).catch(err => {
      logger.error('Error creating temp directory:', err);
    });
  }

  async updateGroups(client, groupUpdate) {
    try {
      logger.info('Starting group update process:', groupUpdate);
      
      const results = [];
      const errors = [];
      let tempFilePath = null;

      // אם יש תמונה בbase64, נשמור אותה כקובץ זמני
      if (groupUpdate.newImageBase64) {
        try {
          const base64Data = groupUpdate.newImageBase64.replace(/^data:image\/\w+;base64,/, '');
          const imageBuffer = Buffer.from(base64Data, 'base64');
          tempFilePath = path.join(this.tempDir, `${uuidv4()}.jpg`);
          await fs.writeFile(tempFilePath, imageBuffer);
          groupUpdate.newImagePath = tempFilePath;
        } catch (error) {
          logger.error('Error saving temp image:', error);
          throw new Error('שגיאה בשמירת התמונה');
        }
      }

      try {
        for (const groupId of groupUpdate.groupIds) {
          try {
            // קבלת הקבוצה
            const chat = await client.getChatById(groupId);

            // עדכון שם אם נדרש
            if (groupUpdate.newName) {
              await chat.setSubject(groupUpdate.newName);
              logger.info(`Updated name for group ${groupId} to ${groupUpdate.newName}`);
            }

            // עדכון תמונה אם נדרש
            if (groupUpdate.newImagePath) {
              const imageBuffer = await fs.readFile(groupUpdate.newImagePath);
              const media = new MessageMedia('image/jpeg', imageBuffer.toString('base64'));
              await chat.setPicture(media);
              logger.info(`Updated image for group ${groupId}`);
            }

            results.push({
              groupId,
              success: true,
              message: 'הקבוצה עודכנה בהצלחה'
            });

            logger.info(`Group ${groupId} updated successfully`);

          } catch (error) {
            logger.error(`Error updating group ${groupId}:`, error);
            errors.push({
              groupId,
              error: error.message
            });
          }

          // המתנה קצרה בין עדכונים למניעת עומס
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } finally {
        // מחיקת הקובץ הזמני אם קיים
        if (tempFilePath) {
          fs.unlink(tempFilePath).catch(err => {
            logger.error('Error deleting temp file:', err);
          });
        }
      }

      return {
        success: results.length > 0,
        results,
        errors: errors.length > 0 ? errors : null,
        totalUpdated: results.length,
        totalFailed: errors.length
      };

    } catch (error) {
      logger.error('Error in updateGroups:', error);
      throw error;
    }
  }

  async validateGroupUpdate(groupUpdate) {
    const errors = [];

    // בדיקת שדות חובה
    if (!groupUpdate.groupIds || groupUpdate.groupIds.length === 0) {
      errors.push('נדרש לבחור לפחות קבוצה אחת לעדכון');
    }

    if (!groupUpdate.newName && !groupUpdate.newImageBase64 && !groupUpdate.newImagePath) {
      errors.push('נדרש לספק שם חדש או תמונה חדשה');
    }

    // בדיקת אורך שם
    if (groupUpdate.newName && (groupUpdate.newName.length < 1 || groupUpdate.newName.length > 25)) {
      errors.push('שם הקבוצה חייב להיות באורך של 1-25 תווים');
    }

    // בדיקת תמונה
    if (groupUpdate.newImageBase64) {
      if (!groupUpdate.newImageBase64.match(/^data:image\/(jpeg|jpg|png);base64,/)) {
        errors.push('פורמט התמונה חייב להיות JPG או PNG');
      }
    } else if (groupUpdate.newImagePath) {
      try {
        await fs.access(groupUpdate.newImagePath);
        if (!groupUpdate.newImagePath.match(/\.(jpg|jpeg|png)$/i)) {
          errors.push('פורמט התמונה חייב להיות JPG או PNG');
        }
      } catch (error) {
        errors.push('קובץ התמונה לא נמצא או לא ניתן לגישה');
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  async retryFailedUpdates(client, failedUpdates, maxRetries = 3) {
    const results = [];
    const finalErrors = [];

    for (const update of failedUpdates) {
      let retries = 0;
      let success = false;

      while (retries < maxRetries && !success) {
        try {
          await this.updateGroups(client, {
            groupIds: [update.groupId],
            newName: update.newName,
            newImagePath: update.newImagePath
          });
          
          results.push({
            groupId: update.groupId,
            success: true,
            retries: retries + 1
          });
          
          success = true;

        } catch (error) {
          retries++;
          
          if (retries === maxRetries) {
            finalErrors.push({
              groupId: update.groupId,
              error: error.message,
              retries
            });
          }

          // המתנה לפני ניסיון נוסף
          await new Promise(resolve => setTimeout(resolve, 2000 * retries));
        }
      }
    }

    return {
      success: results.length > 0,
      results,
      errors: finalErrors
    };
  }
}

module.exports = new WhatsAppGroupsService(); 