import requests
import json
import warnings
import urllib3
import sys
import traceback
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from webdriver_manager.chrome import ChromeDriverManager

# ביטול כל האזהרות הקשורות ל-SSL
warnings.filterwarnings('ignore', message='Unverified HTTPS request')
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def setup_driver():
    try:
        chrome_options = Options()
        chrome_options.add_argument('--headless')
        chrome_options.add_argument('--no-sandbox')
        chrome_options.add_argument('--disable-dev-shm-usage')
        chrome_options.add_argument('--disable-gpu')
        chrome_options.add_argument('--window-size=1920,1080')
        chrome_options.add_argument('--disable-notifications')
        chrome_options.add_argument('--disable-extensions')
        chrome_options.add_argument('--disable-infobars')
        
        service = Service(ChromeDriverManager().install())
        driver = webdriver.Chrome(service=service, options=chrome_options)
        return driver
    except Exception as e:
        error_msg = {
            "error": "Failed to setup Chrome driver",
            "details": str(e),
            "trace": traceback.format_exc()
        }
        print(json.dumps(error_msg, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)

def scrape_event_data(url):
    driver = None
    try:
        driver = setup_driver()
        
        # טעינת הדף
        driver.get(url)
        
        # המתנה לטעינת התוכן
        try:
            WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.TAG_NAME, "body"))
            )
        except TimeoutException:
            raise Exception("Page load timeout")
        
        # חילוץ הכותרת
        title = driver.title.strip()
        if not title:
            raise Exception("Failed to extract title")
        
        # חילוץ תמונה
        try:
            image = driver.find_element(By.CSS_SELECTOR, 'meta[property="og:image"]').get_attribute('content')
        except NoSuchElementException:
            # נסה למצוא תמונה בדרכים אחרות
            try:
                image = driver.find_element(By.CSS_SELECTOR, 'img[src*="header"], img[src*="main"], img[src*="hero"]').get_attribute('src')
            except NoSuchElementException:
                image = None
        
        # חילוץ תאריך
        date_text = None
        try:
            elements = driver.find_elements(By.XPATH, "//*[contains(text(), '05:30') or contains(text(), '23:30')]")
            if elements:
                date_text = elements[0].text.strip()
        except Exception:
            pass
        
        result = {
            "eventName": _cleanEventName(title),
            "imageUrl": image,
            "eventDate": date_text,
            "url": url
        }
        
        print(json.dumps(result, ensure_ascii=False))
        return result
            
    except Exception as e:
        error_msg = {
            "error": str(e),
            "details": traceback.format_exc(),
            "url": url
        }
        print(json.dumps(error_msg, ensure_ascii=False), file=sys.stderr)
        return None
        
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass

def _cleanEventName(eventName):
    if not eventName:
        return ""
    return eventName.replace("כרטיסים ", "").strip()

if __name__ == "__main__":
    if len(sys.argv) > 1:
        url = sys.argv[1]
        scrape_event_data(url)
    else:
        print(json.dumps({"error": "No URL provided"}, ensure_ascii=False), file=sys.stderr) 