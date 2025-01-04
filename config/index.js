require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? 
      JSON.parse(process.env.FIREBASE_PRIVATE_KEY) : undefined,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  },
  whatsapp: {
    retryAttempts: 3,
    retryDelay: 1000,
  }
}; 