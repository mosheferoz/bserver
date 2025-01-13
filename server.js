require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const config = require('./config');
const logger = require('./logger');
const rateLimiter = require('./middleware/rateLimiter');
const scraperRoutes = require('./routes/scraper.routes');
const whatsappService = require('./services/whatsapp.service');
const whatsappRoutes = require('./routes/whatsapp.routes');

// יצירת אפליקציית Express
const app = express();

// יצירת שרת HTTP
const server = require('http').createServer(app);

// הגדרת Socket.IO
const io = require('socket.io')(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.CORS_ORIGIN.split(',')
    : '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());
app.use(helmet());
app.use(compression());
app.use(rateLimiter);

// נתיבים
app.use('/api/scraper', scraperRoutes);
app.use('/api/whatsapp', whatsappRoutes);

// נתיב בדיקת בריאות
app.use('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// הוסף את זה לפני הטיפול בשגיאות 404
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok',
    message: 'WhatsApp Bulk Sender API',
    endpoints: {
      health: '/api/health',
      whatsapp: {
        qr: '/api/whatsapp/qr/:sessionId',
        status: '/api/whatsapp/status/:sessionId',
        send: '/api/whatsapp/send',
        history: '/api/whatsapp/history'
      },
      scraper: '/api/scraper/scrape'
    }
  });
});

// טיפול בשגיאות 404
app.use((req, res) => {
  logger.warn(`404 - Route not found: ${req.method} ${req.url}`);
  res.status(404).json({ 
    error: 'Route not found',
    requestedPath: req.url,
    availableEndpoints: {
      health: '/api/health',
      whatsapp: {
        qr: '/api/whatsapp/qr/:sessionId',
        status: '/api/whatsapp/status/:sessionId',
        send: '/api/whatsapp/send',
        history: '/api/whatsapp/history'
      },
      scraper: '/api/scraper/scrape'
    }
  });
});

// טיפול בשגיאות כלליות
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// אתחול WhatsApp והפעלת השרת
(async () => {
  try {
    const defaultSessionId = process.env.WHATSAPP_CLIENT_ID || 'default-session';
    await whatsappService.initialize(defaultSessionId);
    await startServer();
  } catch (err) {
    logger.error('Failed to initialize:', err);
    process.exit(1);
  }
})();

// הגעלת השרת
const startServer = async (retries = 3) => {
  const PORT = process.env.PORT || 10000;
  const HOST = process.env.HOST || '0.0.0.0';
  
  try {
    await new Promise((resolve, reject) => {
      server.listen(PORT, HOST)
        .once('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            logger.warn(`Port ${PORT} is busy`);
            reject(err);
          } else {
            reject(err);
          }
        })
        .once('listening', () => {
          logger.info(`Server running on http://${HOST}:${PORT}`);
          resolve();
        });
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

// הגדרת Socket.IO
io.on('connection', (socket) => {
  logger.info('New client connected');

  socket.on('join_whatsapp_room', (sessionId) => {
    logger.info(`Client joined WhatsApp room for session ${sessionId}`);
    socket.join(`whatsapp_${sessionId}`);
  });

  socket.on('disconnect', () => {
    logger.info('Client disconnected');
  });
});

// הגדרת Socket.IO בשירות WhatsApp
whatsappService.setSocketIO(io);
