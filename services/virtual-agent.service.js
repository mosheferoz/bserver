const axios = require('axios');
const admin = require('firebase-admin');
const config = require('../config');
const logger = require('../logger');

class VirtualAgentService {
    constructor() {
        this.rasaUrl = process.env.RASA_URL || 'http://localhost:6005';
    }

    async getVirtualAgentForEvent(eventId) {
        try {
            const db = admin.firestore();
            const eventDoc = await db.collection('events').doc(eventId).get();
            const event = eventDoc.data();
            
            if (!event.virtualAgentId) {
                return null;
            }

            const agentDoc = await db.collection('virtualAgents').doc(event.virtualAgentId).get();
            return agentDoc.data();
        } catch (error) {
            logger.error('Error getting virtual agent:', error);
            return null;
        }
    }

    async handleIncomingMessage(message, eventId, phoneNumber) {
        try {
            const virtualAgent = await this.getVirtualAgentForEvent(eventId);
            if (!virtualAgent) {
                return null;
            }

            // שליחת ההודעה ל-Rasa עם הקונטקסט של הנציג הוירטואלי
            const response = await axios.post(`${this.rasaUrl}/webhooks/rest/webhook`, {
                sender: phoneNumber,
                message: message,
                metadata: {
                    eventId: eventId,
                    virtualAgent: {
                        name: virtualAgent.name,
                        communicationStyle: virtualAgent.communicationStyle,
                        knowledgeArea: virtualAgent.knowledgeArea,
                        customFields: virtualAgent.customFields
                    }
                }
            });

            if (response.data && response.data.length > 0) {
                return response.data[0].text;
            }
            return null;
        } catch (error) {
            logger.error('Error handling message with Rasa:', error);
            return null;
        }
    }

    async isAutoReplyEnabled(phoneNumber) {
        try {
            const db = admin.firestore();
            const numberDoc = await db.collection('phoneNumbers')
                                   .where('number', '==', phoneNumber)
                                   .get();
            
            if (numberDoc.empty) {
                return false;
            }

            const numberData = numberDoc.docs[0].data();
            return numberData.autoReplyEnabled && numberData.eventId;
        } catch (error) {
            logger.error('Error checking auto reply status:', error);
            return false;
        }
    }
}

module.exports = new VirtualAgentService(); 