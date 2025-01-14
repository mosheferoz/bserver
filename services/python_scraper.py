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
        # מחפש טקסט שמתחיל עם "EXPO TLV" או מכיל "חג פורים"
        content_blocks = []
        
        # מחפש את כל הטקסטים בדף
        texts = soup.find_all(text=True)
        
        # מחפש את האינדקס של תחילת התיאור
        start_index = -1
        for i, text in enumerate(texts):
            if 'EXPO TLV' in text or 'חג פורים' in text:
                start_index = i
                break
        
        if start_index != -1:
            # אוסף את כל הטקסטים הרלוונטיים עד שמגיעים לחלק של הנהלים או הכפתורים
            current_block = []
            for text in texts[start_index:]:
                cleaned_text = text.strip()
                if not cleaned_text:
                    continue
                    
                # עוצר כשמגיעים לחלק של הנהלים או כפתורי הניווט
                if any(stop_word in cleaned_text for stop_word in ['נהלים והנחיות', 'מציאת אירועים', 'יצירת אירוע', 'LOGIN']):
                    break
                    
                # מוסיף רק טקסטים משמעותיים
                if len(cleaned_text) > 5 and not cleaned_text.startswith('http'):
                    current_block.append(cleaned_text)
            
            if current_block:
                content_blocks.extend(current_block)
        
        if content_blocks:
            # מסנן כפילויות
            unique_blocks = []
            for block in content_blocks:
                if block not in unique_blocks:
                    unique_blocks.append(block)
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