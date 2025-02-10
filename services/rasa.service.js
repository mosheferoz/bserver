const axios = require('axios');
const logger = require('../logger');

class RasaService {
  constructor() {
    this.rasaUrl = 'http://localhost:5005';
    this.actionsUrl = 'http://localhost:6055';
  }

  async sendMessage(message, sessionId) {
    try {
      logger.info(`Sending message to Rasa for session ${sessionId}:`, message);
      logger.info(`Using Rasa URL: ${this.rasaUrl}`);
      
      const payload = {
        sender: sessionId,
        message: message
      };
      logger.info('Request payload:', payload);
      
      const response = await axios.post(`${this.rasaUrl}/webhooks/rest/webhook`, payload);
      logger.info(`Received response from Rasa for session ${sessionId}:`, response.data);
      
      return response.data;
    } catch (error) {
      logger.error('Error sending message to Rasa:', {
        error: error.message,
        sessionId,
        message,
        stack: error.stack
      });
      throw error;
    }
  }

  async trainModel() {
    try {
      const response = await axios.post(`${this.rasaUrl}/model/train`);
      return response.data;
    } catch (error) {
      logger.error('Error training Rasa model:', error);
      throw error;
    }
  }
}

module.exports = new RasaService(); 