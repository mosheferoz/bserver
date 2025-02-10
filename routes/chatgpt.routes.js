const express = require('express');
const router = express.Router();
const chatGPTService = require('../services/chatgpt.service');

router.post('/analyze-event', async (req, res) => {
  try {
    const { description } = req.body;
    if (!description) {
      return res.status(400).json({ error: 'נדרש תיאור אירוע' });
    }

    const analysis = await chatGPTService.analyzeEventDescription(description);
    res.json(analysis);
  } catch (error) {
    console.error('שגיאה בניתוח אירוע:', error);
    res.status(500).json({ error: 'שגיאה בניתוח האירוע' });
  }
});

module.exports = router; 