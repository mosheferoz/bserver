import requests
import json
import warnings
import urllib3
import sys
import os
import traceback
from bs4 import BeautifulSoup

# ביטול כל האזהרות הקשורות ל-SSL
warnings.filterwarnings('ignore', message='Unverified HTTPS request')
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def check_environment():
    """בדיקת הסביבה והדפסת מידע שימושי לדיבוג"""
    print("Python version:", sys.version, file=sys.stderr)
    print("Current working directory:", os.getcwd(), file=sys.stderr)
    print("PATH environment:", os.environ.get('PATH', ''), file=sys.stderr)
    print("PYTHONPATH environment:", os.environ.get('PYTHONPATH', ''), file=sys.stderr)
    print("Virtual env:", os.environ.get('VIRTUAL_ENV', 'Not in virtualenv'), file=sys.stderr)

def scrape_event_data(url):
    print(f"Starting to scrape URL: {url}", file=sys.stderr)
    try:
        print("Sending request...", file=sys.stderr)
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        response = requests.get(url, headers=headers, verify=False)
        response.raise_for_status()
        
        print("Parsing HTML...", file=sys.stderr)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        print("Extracting title...", file=sys.stderr)
        title = soup.title.string.strip() if soup.title else None
        if not title:
            raise Exception("Failed to extract title")
        
        print("Extracting image...", file=sys.stderr)
        image = None
        og_image = soup.find('meta', property='og:image')
        if og_image:
            image = og_image.get('content')
        else:
            img_tag = soup.find('img', src=lambda x: x and ('header' in x or 'main' in x or 'hero' in x))
            if img_tag:
                image = img_tag.get('src')
        
        print("Extracting date...", file=sys.stderr)
        date_text = None
        for element in soup.find_all(text=True):
            if '05:30' in element or '23:30' in element:
                date_text = element.strip()
                break

        print("Extracting description...", file=sys.stderr)
        description = ""
        
        # מחפש את התיאור בצורה ממוקדת
        content_blocks = []
        
        # מוצא את כל הדיבים שמכילים טקסט
        for div in soup.find_all(['div', 'p', 'span']):
            text = div.get_text(strip=True)
            if not text:
                continue
                
            # מתעלם מ-JSON וטקסטים לא רלוונטיים
            if text.startswith('{') or text.startswith('[') or text.startswith('//'):
                continue
                
            if any(skip_word in text.lower() for skip_word in [
                'login', 'sign up', 'visitor', 'android', 'ios',
                'מציאת אירועים', 'יצירת אירוע', 'הכרטיסים שלי', 'ניהול',
                'שפה ומיקום', 'הורדת האפליקציה'
            ]):
                continue
                
            # מחפש טקסטים שמתאימים לתיאור האירוע
            if ('expo tlv' in text.lower() or 
                'חג פורים' in text or 
                'פסטיבל' in text or
                'אירוע' in text):
                
                # מפצל את הטקסט לפי שורות ומסנן שורות ריקות
                lines = [line.strip() for line in text.split('\n') if line.strip()]
                
                for line in lines:
                    # מסנן שורות קצרות מדי או שורות שמכילות רק תווים מיוחדים
                    if len(line) > 5 and not all(c in '.,!?-_*#@&' for c in line):
                        content_blocks.append(line)
        
        if content_blocks:
            # מסנן כפילויות
            unique_blocks = []
            seen = set()
            for block in content_blocks:
                if block not in seen:
                    seen.add(block)
                    unique_blocks.append(block)
            
            # מסדר את הבלוקים לפי הסדר הנכון
            description = '\n\n'.join(unique_blocks)
        
        result = {
            "eventName": _cleanEventName(title),
            "imageUrl": image,
            "eventDate": date_text,
            "description": description,
            "url": url
        }
        
        print("Scraping completed successfully", file=sys.stderr)
        print(json.dumps(result, ensure_ascii=False))
        return result
            
    except Exception as e:
        error_msg = {
            "error": str(e),
            "details": traceback.format_exc(),
            "url": url
        }
        print(json.dumps(error_msg, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)

def _cleanEventName(eventName):
    if not eventName:
        return ""
    return eventName.replace("כרטיסים ", "").strip()

if __name__ == "__main__":
    if len(sys.argv) > 1:
        url = sys.argv[1]
        print(f"Starting script with URL: {url}", file=sys.stderr)
        scrape_event_data(url)
    else:
        print(json.dumps({"error": "No URL provided"}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1) 