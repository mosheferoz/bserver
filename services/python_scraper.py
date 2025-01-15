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
        
        print("Extracting date and description from JSON...", file=sys.stderr)
        date_text = None
        description = ""
        
        # מחפש את ה-JSON המוטמע בדף
        scripts = soup.find_all('script')
        for script in scripts:
            if script.string and 'window.__NEXT_DATA__' in script.string:
                try:
                    # מחלץ את ה-JSON מהסקריפט
                    json_str = script.string.split('=', 1)[1].strip()
                    data = json.loads(json_str)
                    
                    # מחפש את המידע הרלוונטי ב-JSON
                    if 'props' in data and 'pageProps' in data['props'] and 'event' in data['props']['pageProps']:
                        event_data = data['props']['pageProps']['event']
                        
                        # מחלץ את התאריך
                        if 'StartingDate' in event_data:
                            date_text = event_data['StartingDate']
                        
                        # בונה את התיאור מהשדות הרלוונטיים
                        description_parts = []
                        
                        if 'Adress' in event_data:
                            description_parts.append(f"מיקום: {event_data['Adress']}")
                        
                        if 'MusicType' in event_data and isinstance(event_data['MusicType'], list):
                            description_parts.append(f"סוגי מוזיקה: {', '.join(event_data['MusicType'])}")
                        
                        if 'EventType' in event_data:
                            description_parts.append(f"סוג אירוע: {event_data['EventType']}")
                        
                        if 'MinimumAge' in event_data:
                            description_parts.append(f"גיל מינימלי: {event_data['MinimumAge']}")
                        
                        # מוסיף את התיאור המלא מהדף
                        if 'Description' in event_data:
                            description_parts.append(event_data['Description'])
                        
                        description = '\n\n'.join(description_parts)
                        break
                except Exception as e:
                    print(f"Error parsing JSON: {e}", file=sys.stderr)
                    continue
        
        # אם לא מצאנו תיאור ב-JSON, ננסה לחפש בטקסט הרגיל
        if not description:
            print("Falling back to text extraction...", file=sys.stderr)
            content_blocks = []
            for div in soup.find_all(['div', 'p']):
                text = div.get_text(strip=True)
                if text and len(text) > 30 and 'expo tlv' in text.lower():
                    content_blocks.append(text)
            if content_blocks:
                description = '\n\n'.join(content_blocks)
        
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