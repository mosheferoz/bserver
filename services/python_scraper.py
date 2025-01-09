import requests
import json
import warnings
import urllib3
import sys
import os
import traceback
from bs4 import BeautifulSoup
import asyncio
from pyppeteer import launch

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

async def scrape_event_data(url):
    print(f"Starting to scrape URL: {url}", file=sys.stderr)
    browser = None
    try:
        print("Launching browser...", file=sys.stderr)
        browser = await launch({
            'headless': True,
            'args': [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-features=VizDisplayCompositor'
            ]
        })
        
        print("Creating new page...", file=sys.stderr)
        page = await browser.newPage()
        await page.setViewport({'width': 1920, 'height': 1080})
        
        print(f"Navigating to URL: {url}", file=sys.stderr)
        await page.goto(url, {'waitUntil': 'networkidle0', 'timeout': 30000})
        
        print("Extracting title...", file=sys.stderr)
        title = await page.title()
        if not title:
            raise Exception("Failed to extract title")
        
        print("Extracting image...", file=sys.stderr)
        image = None
        try:
            image = await page.evaluate('''() => {
                const ogImage = document.querySelector('meta[property="og:image"]');
                if (ogImage) return ogImage.getAttribute('content');
                
                const headerImage = document.querySelector('img[src*="header"], img[src*="main"], img[src*="hero"]');
                return headerImage ? headerImage.getAttribute('src') : null;
            }''')
        except Exception as e:
            print(f"Error extracting image: {str(e)}", file=sys.stderr)
        
        print("Extracting date...", file=sys.stderr)
        date_text = None
        try:
            date_text = await page.evaluate('''() => {
                const elements = Array.from(document.querySelectorAll('*'));
                const dateElement = elements.find(el => 
                    el.textContent.includes('05:30') || el.textContent.includes('23:30')
                );
                return dateElement ? dateElement.textContent.trim() : null;
            }''')
        except Exception as e:
            print(f"Error extracting date: {str(e)}", file=sys.stderr)
        
        result = {
            "eventName": _cleanEventName(title),
            "imageUrl": image,
            "eventDate": date_text,
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
        
    finally:
        if browser:
            try:
                print("Closing browser...", file=sys.stderr)
                await browser.close()
            except Exception as e:
                print(f"Error closing browser: {str(e)}", file=sys.stderr)

def _cleanEventName(eventName):
    if not eventName:
        return ""
    return eventName.replace("כרטיסים ", "").strip()

if __name__ == "__main__":
    if len(sys.argv) > 1:
        url = sys.argv[1]
        print(f"Starting script with URL: {url}", file=sys.stderr)
        asyncio.get_event_loop().run_until_complete(scrape_event_data(url))
    else:
        print(json.dumps({"error": "No URL provided"}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1) 