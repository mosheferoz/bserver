const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const logger = require('../logger');

router.post('/scrape', async (req, res) => {
    try {
        const { url } = req.body;
        logger.info('Received scraping request for URL:', url);
        
        if (!url) {
            logger.warn('No URL provided in request');
            return res.status(400).json({ error: 'URL is required' });
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            logger.warn('Invalid URL format:', url);
            return res.status(400).json({ error: 'Invalid URL format. URL must start with http:// or https://' });
        }

        const pythonScriptPath = path.join(__dirname, '../services/python_scraper.py');
        logger.info('Python script path:', pythonScriptPath);
        
        // שימוש ב-python3 ישירות
        const pythonProcess = spawn('python3', [pythonScriptPath, url]);

        let dataString = '';
        let errorString = '';

        pythonProcess.stdout.on('data', (data) => {
            logger.debug('Python stdout:', data.toString());
            dataString += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            logger.error('Python stderr:', data.toString());
            errorString += data.toString();
        });

        // טיפול בשגיאות תהליך
        pythonProcess.on('error', (error) => {
            logger.error('Failed to start Python process:', error);
            return res.status(500).json({ 
                error: 'Failed to start scraping process',
                details: error.message
            });
        });

        pythonProcess.on('close', (code) => {
            logger.info('Python process exited with code:', code);
            
            if (code !== 0) {
                logger.error('Python process failed');
                logger.error('Error output:', errorString);
                
                try {
                    // נסה לפרסר את השגיאה מ-Python
                    const errorObj = JSON.parse(errorString);
                    return res.status(500).json({ 
                        error: 'Failed to scrape data',
                        details: errorObj
                    });
                } catch (parseError) {
                    return res.status(500).json({ 
                        error: 'Failed to scrape data',
                        details: errorString
                    });
                }
            }

            try {
                logger.debug('Trying to parse Python output:', dataString);
                const result = JSON.parse(dataString);
                
                if (!result.eventName) {
                    logger.warn('No event name found in scraped data');
                    return res.status(404).json({ 
                        error: 'No event data found',
                        details: 'Could not find event information on the page'
                    });
                }
                
                logger.info('Successfully scraped data:', result);
                return res.json(result);
            } catch (error) {
                logger.error('Failed to parse Python output:', error);
                logger.error('Raw output:', dataString);
                return res.status(500).json({ 
                    error: 'Failed to parse scraped data',
                    details: error.message,
                    raw: dataString
                });
            }
        });

    } catch (error) {
        logger.error('Server error:', error);
        return res.status(500).json({ 
            error: 'Internal server error',
            details: error.message
        });
    }
});

module.exports = router; 