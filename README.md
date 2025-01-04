# WhatsApp Bulk Sender with Web Scraping

שירות משולב לשליחת הודעות WhatsApp והוצאת מידע מאתרים.

## התקנה

### Node.js
1. הn
```bash
npm install
```

### Python
1. התקן את Python 3.8 או גרסה חדשה יותר

2. התקן את ChromeDriver:
- ב-macOS:
```bash
brew install chromedriver
```
- ב-Linux:
```bash
sudo apt-get install chromium-chromedriver
```
- ב-Windows:
הורד את ChromeDriver מהאתר הרשמי והוסף אותו ל-PATH

3. צור סביבה וירטואלית:
```bash
python3 -m venv venv
```

4. הפעל את הסביבה הוירטואלית:
- ב-macOS/Linux:
```bash
source venv/bin/activate
```
- ב-Windows:
```bash
.\venv\Scripts\activate
```

5. התקן את התלויות של Python:
```bash
pip install beautifulsoup4 selenium requests webdriver_manager
```

## הגדרות סביבה
1. העתק את קובץ `.env.example` ל-`.env`
2. עדכן את הערכים בקובץ `.env` לפי הצורך

## הפעלה
1. הפעל את השרת:
```bash
npm run dev
```

## תכונות
- שליחת הודעות WhatsApp
- הוצאת מידע מאתרים
- תמיכה בקבצי CSV
- ניהול סשן WhatsApp
- לוגים מפורטים

## API Endpoints

### WhatsApp
- `POST /api/whatsapp/send` - שליחת הודעה
- `GET /api/whatsapp/status` - בדיקת סטטוס חיבור
- `GET /api/whatsapp/qr` - קבלת קוד QR לחיבור

### Web Scraping
- `POST /api/scraper/scrape` - הוצאת מידע מאתר

## דוגמה לבקשת Scraping
```bash
curl -X POST http://localhost:3000/api/scraper/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```