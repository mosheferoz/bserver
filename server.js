require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { spawn } = require('child_process');
const path = require('path');
const morgan = require('morgan');
const config = require('./config');
const logger = require('./logger');
const rateLimiter = require('./middleware/rateLimiter');
const authenticateToken = require('./middleware/auth');
const scraperRoutes = require('./routes/scraper.routes');
const whatsappService = require('./services/whatsapp.service');
const whatsappRoutes = require('./routes/whatsapp.routes');
const chatgptRoutes = require('./routes/chatgpt.routes');
const eventsRoutes = require('./routes/events.routes');
const virtualAgentsRoutes = require('./routes/virtual-agents.routes');
const rasaWhatsAppService = require('./services/rasa-whatsapp.service');
const backgroundSenderService = require('./services/background-sender.service');

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

// העברת ה-socket.io instance לשירות ה-WhatsApp
whatsappService.setSocketIO(io);

// העברת ה-socket.io instance לשירותים
backgroundSenderService.setSocketIO(io);

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
app.use('/api/chatgpt', chatgptRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/virtual-agents', virtualAgentsRoutes);

// נתיבי שליחה ברקע
app.post('/api/background-sender/start', authenticateToken, async (req, res) => {
  try {
    const success = await backgroundSenderService.startSending(req.body);
    res.json({ success });
  } catch (error) {
    logger.error('Error starting background sending:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/background-sender/stop', authenticateToken, async (req, res) => {
  try {
    const { numberId } = req.body;
    const success = await backgroundSenderService.stopSending(numberId);
    res.json({ success });
  } catch (error) {
    logger.error('Error stopping background sending:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/background-sender/reset', authenticateToken, async (req, res) => {
  try {
    const { numberId } = req.body;
    const success = await backgroundSenderService.resetSendingState(numberId);
    res.json({ success });
  } catch (error) {
    logger.error('Error resetting background sending state:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/background-sender/status/:numberId', authenticateToken, async (req, res) => {
  try {
    const { numberId } = req.params;
    const status = backgroundSenderService.activeSenders.get(numberId) || {
      isSending: false,
      sentCount: 0,
      totalCount: 0,
      lastSentIndex: -1
    };
    res.json(status);
  } catch (error) {
    logger.error('Error getting background sending status:', error);
    res.status(500).json({ error: error.message });
  }
});

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
      scraper: '/api/scraper/scrape',
      events: '/api/events',
      virtualAgents: '/api/virtual-agents'
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
      scraper: '/api/scraper/scrape',
      events: '/api/events',
      virtualAgents: '/api/virtual-agents'
    }
  });
});

// הוספת תהליכי Rasa
let rasaProcess = null;
let rasaActionsProcess = null;

function startRasa() {
    // הפעלת שרת ה-Rasa
    rasaProcess = spawn('rasa', ['run', '--enable-api', '--cors', '*'], {
        cwd: path.join(__dirname, 'rasa'),
        shell: true,
        env: {
            ...process.env,
            PYTHONPATH: process.env.PYTHONPATH || '',
            SQLALCHEMY_SILENCE_UBER_WARNING: '1',
            LOG_LEVEL: 'DEBUG'
        }
    });

    rasaProcess.stdout.on('data', (data) => {
        logger.info(`Rasa: ${data}`);
    });

    rasaProcess.stderr.on('data', (data) => {
        logger.error(`Rasa Error: ${data}`);
    });

    // הפעלת שרת ה-Actions
    rasaActionsProcess = spawn('rasa', ['run', 'actions'], {
        cwd: path.join(__dirname, 'rasa'),
        shell: true,
        env: {
            ...process.env,
            PYTHONPATH: process.env.PYTHONPATH || '',
            SQLALCHEMY_SILENCE_UBER_WARNING: '1',
            LOG_LEVEL: 'DEBUG'
        }
    });

    rasaActionsProcess.stdout.on('data', (data) => {
        logger.info(`Rasa Actions: ${data}`);
    });

    rasaActionsProcess.stderr.on('data', (data) => {
        logger.error(`Rasa Actions Error: ${data}`);
    });
}

// אתחול WhatsApp, Rasa והפעלת השרת
(async () => {
  try {
    const defaultSessionId = process.env.WHATSAPP_CLIENT_ID || 'default-session';
    await whatsappService.initialize(defaultSessionId);
    startRasa(); // הפעלת Rasa
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

// ניקוי בעת סגירת השרת
process.on('SIGTERM', async () => {
    if (rasaProcess) rasaProcess.kill();
    if (rasaActionsProcess) rasaActionsProcess.kill();
    // ... existing cleanup code ...
});

process.on('SIGINT', async () => {
    if (rasaProcess) rasaProcess.kill();
    if (rasaActionsProcess) rasaActionsProcess.kill();
    // ... existing cleanup code ...
});
