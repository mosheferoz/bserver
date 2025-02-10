const express = require('express');
const app = express();
const cors = require('cors');
require('dotenv').config();

app.use(cors());

// הגדרת גודל מקסימלי לבקשות - 200MB
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

const chatgptRoutes = require('./routes/chatgpt.routes');
const whatsappRoutes = require('./routes/whatsapp.routes');

// הגדרת הנתיבים הבסיסיים
app.use('/api/chatgpt', chatgptRoutes);
app.use('/api/whatsapp', whatsappRoutes);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`השרת רץ על פורט ${PORT}`);
}); 