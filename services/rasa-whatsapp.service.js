const axios = require('axios');
const logger = require('../logger');
const whatsappService = require('./whatsapp.service');
const admin = require('firebase-admin');

class RasaWhatsAppService {
    constructor() {
        this.activeAgents = new Map(); // sessionId -> { eventId, agentId, agentData }
    }

    async initializeAgent(sessionId, eventId, agentId) {
        try {
            // בדיקה אם הנציג כבר פעיל
            if (this.activeAgents.has(sessionId)) {
                logger.info(`Agent already active for session ${sessionId}`);
                return true;
            }

            // שמירת פרטי הנציג הווירטואלי
            this.activeAgents.set(sessionId, {
                eventId,
                agentId,
                lastInteraction: new Date()
            });

            logger.info(`Virtual agent ${agentId} activated for event ${eventId} in session ${sessionId}`);
            return true;
        } catch (error) {
            logger.error('Error initializing virtual agent:', error);
            return false;
        }
    }

    async deactivateAgent(sessionId) {
        try {
            this.activeAgents.delete(sessionId);
            logger.info(`Virtual agent deactivated for session ${sessionId}`);
            return true;
        } catch (error) {
            logger.error('Error deactivating virtual agent:', error);
            return false;
        }
    }

    isAgentActive(sessionId) {
        return this.activeAgents.has(sessionId);
    }

    async handleIncomingMessage(sessionId, message, sender) {
        try {
            if (!this.isAgentActive(sessionId)) {
                logger.warn(`No active agent for session ${sessionId}`);
                return;
            }

            const agentInfo = this.activeAgents.get(sessionId);
            
            // קבלת פרטי האירוע מ-Firestore
            let eventData = {};
            try {
                const eventDoc = await admin.firestore()
                    .collection('events')
                    .doc(agentInfo.eventId)
                    .get();
                
                if (eventDoc.exists) {
                    eventData = eventDoc.data();
                    logger.info(`Retrieved event data for ${agentInfo.eventId}:`, eventData);
                } else {
                    logger.warn(`Event ${agentInfo.eventId} not found in Firestore`);
                }
            } catch (error) {
                logger.error('Error fetching event data:', error);
            }

            // עיבוד המידע לפורמט המתאים
            const processedData = {
                min_age: eventData.customFields?.minAge || 'לא צוין',
                max_age: eventData.customFields?.maxAge || 'לא צוין',
                event_name: eventData.eventName || 'האירוע',
                event_date: eventData.eventDate || 'לא צוין',
                location: eventData.customFields?.location || 'לא צוין',
                price: eventData.customFields?.price || 'לא צוין',
                event_info: eventData.eventInfo || 'אין מידע נוסף',
                event_link: eventData.eventLink || 'לא צוין',
                venue_name: eventData.customFields?.venueName || '',
                address: eventData.customFields?.address || 'לא צוין',
                parking_info: eventData.customFields?.parkingInfo || 'אין מידע על חניה',
                accessibility: eventData.customFields?.accessibility || 'אין מידע על נגישות',
                age_restriction: eventData.customFields?.ageRestriction || 'אין הגבלת גיל',
                ticket_types: eventData.customFields?.ticketTypes || 'לא צוין',
                vip_price: eventData.customFields?.vipPrice || 'לא צוין',
                regular_price: eventData.customFields?.regularPrice || 'לא צוין',
                student_price: eventData.customFields?.studentPrice || 'לא צוין',
                group_discount: eventData.customFields?.groupDiscount || 'אין הנחת קבוצות',
                start_time: eventData.customFields?.startTime || 'לא צוין',
                end_time: eventData.customFields?.endTime || 'לא צוין',
                performers: eventData.customFields?.performers || 'כרגע בהפתעה',
                special_guests: eventData.customFields?.specialGuests || '',
                program: eventData.customFields?.program || 'אין מידע על התוכנית',
                dress_code: eventData.customFields?.dressCode || 'אין קוד לבוש מיוחד',
                food_drinks: eventData.customFields?.foodDrinks || 'אין מידע על אוכל ושתייה',
                kosher_info: eventData.customFields?.kosherInfo || 'אין מידע על כשרות'
            };

            logger.info('Sending message to Rasa with processed data:', processedData);

            // שליחת ההודעה ל-Rasa עם המידע המעובד
            const response = await axios.post('http://localhost:5005/webhooks/rest/webhook', {
                sender: sender,
                message: message,
                metadata: {
                    eventId: agentInfo.eventId,
                    agentId: agentInfo.agentId,
                    ...processedData
                }
            });

            // טיפול בתשובה מ-Rasa
            if (response.data && response.data.length > 0) {
                for (const botResponse of response.data) {
                    if (botResponse.text) {
                        await whatsappService.sendMessage({
                            sessionId,
                            recipient: { phone: sender },
                            message: botResponse.text
                        });
                    }
                }
            }

            // עדכון זמן האינטראקציה האחרונה
            agentInfo.lastInteraction = new Date();
            this.activeAgents.set(sessionId, agentInfo);

        } catch (error) {
            logger.error('Error handling incoming message:', error);
            throw error;
        }
    }
}

module.exports = new RasaWhatsAppService(); 