const admin = require('firebase-admin');
const path = require('path');
const config = require('../config');
const logger = require('../logger');

let db = null;

function initializeFirebase() {
  try {
    if (!config.firebase) {
      logger.warn('Firebase configuration not found, skipping initialization');
      return null;
    }

    if (!admin.apps.length) {
      const credentials = {
        projectId: config.firebase.projectId,
        clientEmail: config.firebase.clientEmail,
        privateKey: config.firebase.privateKey
      };

      if (!credentials.projectId || !credentials.clientEmail || !credentials.privateKey) {
        logger.warn('Missing required Firebase credentials, skipping initialization');
        return null;
      }

      logger.info('Initializing Firebase with credentials:', {
        projectId: credentials.projectId,
        clientEmail: credentials.clientEmail,
        hasPrivateKey: !!credentials.privateKey
      });

      admin.initializeApp({
        credential: admin.credential.cert(credentials),
        databaseURL: `https://${config.firebase.projectId}.firebaseio.com`
      });

      db = admin.firestore();
      
      db.collection('test').get()
        .then(() => logger.info('Firestore connection successful'))
        .catch(error => logger.error('Firestore connection error:', error));
    }
  } catch (error) {
    logger.error('Failed to initialize Firebase:', error);
    return null;
  }
  
  return db;
}

const mockDb = {
  collection: () => ({
    get: () => Promise.resolve([]),
    add: () => Promise.resolve({}),
    doc: () => ({
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      update: () => Promise.resolve(),
      delete: () => Promise.resolve()
    })
  })
};

module.exports = {
  db: db || initializeFirebase() || mockDb,
  admin
}; 