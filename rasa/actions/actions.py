# This files contains your custom actions which can be used to run
# custom Python code.
#
# See this guide on how to implement these action:
# https://rasa.com/docs/rasa/custom-actions


# This is a simple example for a custom action which utters "Hello World!"

from typing import Any, Text, Dict, List
from rasa_sdk import Action, Tracker
from rasa_sdk.executor import CollectingDispatcher
import firebase_admin
from firebase_admin import credentials, firestore
import os
import logging

# הגדרת לוגר
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize Firebase if not already initialized
if not firebase_admin._apps:
    try:
        # נסה למצוא את הקובץ במספר מיקומים אפשריים
        possible_paths = [
            '../config/firebase-credentials.json',
            '../../config/firebase-credentials.json',
            'config/firebase-credentials.json',
            '/app/config/firebase-credentials.json'
        ]
        
        cred_path = None
        for path in possible_paths:
            if os.path.exists(path):
                cred_path = path
                break
                
        if cred_path:
            logger.info(f"Found Firebase credentials at: {cred_path}")
            cred = credentials.Certificate(cred_path)
            firebase_admin.initialize_app(cred)
        else:
            logger.error("Could not find Firebase credentials file")
            raise FileNotFoundError("Firebase credentials file not found")
            
    except Exception as e:
        logger.error(f"Error initializing Firebase: {e}")
        raise

db = firestore.client()

class ActionGetEventDetails(Action):
    def name(self) -> Text:
        return "action_get_event_details"

    async def run(
        self,
        dispatcher: CollectingDispatcher,
        tracker: Tracker,
        domain: Dict[Text, Any],
    ) -> List[Dict[Text, Any]]:
        
        # קבלת המטה-דאטה מהשיחה
        metadata = tracker.get_slot("metadata")
        if not metadata:
            dispatcher.utter_message(text="מצטער, לא מצאתי מידע על האירוע")
            return []

        event_id = metadata.get("eventId")
        if not event_id:
            dispatcher.utter_message(text="מצטער, לא מצאתי את מזהה האירוע")
            return []

        try:
            # קבלת פרטי האירוע מ-Firestore
            event_doc = db.collection('events').document(event_id).get()
            if not event_doc.exists:
                dispatcher.utter_message(text="מצטער, לא מצאתי את האירוע המבוקש")
                return []

            event_data = event_doc.to_dict()
            
            # בניית הודעת תשובה מפורטת
            response = f"""אשמח לספק לך פרטים על האירוע:
            
שם האירוע: {event_data.get('eventName')}
תאריך: {event_data.get('eventDate')}
מיקום: {event_data.get('location', 'לא צוין')}
מחיר: {event_data.get('price', 'לא צוין')} ש"ח

{event_data.get('eventInfo', '')}

{self._get_discounts_info(event_data)}"""

            dispatcher.utter_message(text=response)

        except Exception as e:
            print(f"Error getting event details: {e}")
            dispatcher.utter_message(text="מצטער, אירעה שגיאה בקבלת פרטי האירוע")

        return []

    def _get_discounts_info(self, event_data: Dict) -> str:
        discounts = event_data.get('discounts', {})
        if not discounts:
            return ""

        discount_text = "\nהנחות זמינות:\n"
        for type_discount, amount in discounts.items():
            discount_text += f"- {type_discount}: {amount}% הנחה\n"
        
        return discount_text

class ActionIntroduceAgent(Action):
    def name(self) -> Text:
        return "action_introduce_agent"

    async def run(
        self,
        dispatcher: CollectingDispatcher,
        tracker: Tracker,
        domain: Dict[Text, Any],
    ) -> List[Dict[Text, Any]]:
        
        metadata = tracker.get_slot("metadata")
        if not metadata:
            dispatcher.utter_message(text="שלום! אני כאן כדי לעזור לך.")
            return []

        virtual_agent = metadata.get("virtualAgent", {})
        name = virtual_agent.get("name", "הנציג הווירטואלי")
        
        introduction = f"""שלום! שמי {name} ואני {virtual_agent.get('communicationStyle', 'כאן כדי לעזור לך')}.
אני מתמחה ב{virtual_agent.get('knowledgeArea', 'מתן מידע על האירוע')} ואשמח לענות על כל שאלה שיש לך."""

        dispatcher.utter_message(text=introduction)
        return []

class ActionCheckAgeRestrictions(Action):
    def name(self) -> Text:
        return "action_check_age_restrictions"

    async def run(
        self,
        dispatcher: CollectingDispatcher,
        tracker: Tracker,
        domain: Dict[Text, Any],
    ) -> List[Dict[Text, Any]]:
        
        try:
            # קבלת המטה-דאטה מההודעה האחרונה
            latest_message = tracker.latest_message
            metadata = latest_message.get('metadata', {})
            logger.info(f"Received metadata from latest message: {metadata}")
            
            if not metadata:
                # אם אין מטה-דאטה בהודעה, ננסה לקבל מה-slots
                metadata = tracker.get_slot("metadata") or {}
                logger.info(f"Received metadata from slot: {metadata}")

            if not metadata:
                logger.error("No metadata found in message or slot")
                dispatcher.utter_message(text="מצטער, לא מצאתי מידע על מגבלות הגיל")
                return []

            # קבלת הגילאים מהמטה-דאטה
            min_age = metadata.get('min_age', 'לא צוין')
            max_age = metadata.get('max_age', None)
            
            logger.info(f"Age restrictions - min: {min_age}, max: {max_age}")

            if min_age == 'לא צוין':
                logger.error("No minimum age found in metadata")
                dispatcher.utter_message(text="מצטער, לא מצאתי מידע על מגבלות גיל לאירוע זה")
                return []

            if max_age and max_age != 'לא צוין':
                # אם יש גיל מקסימום, נשתמש בתבנית עם טווח
                logger.info(f"Using age range template with min: {min_age}, max: {max_age}")
                dispatcher.utter_message(template="utter_age_restrictions",
                                      min_age=min_age,
                                      max_age=max_age)
            else:
                # אם אין גיל מקסימום, נשתמש בתבנית "ומעלה"
                logger.info(f"Using minimum age template with min: {min_age}")
                dispatcher.utter_message(template="utter_age_restrictions_no_max",
                                      min_age=min_age)

        except Exception as e:
            logger.error(f"Error checking age restrictions: {e}", exc_info=True)
            dispatcher.utter_message(text="מצטער, אירעה שגיאה בבדיקת מגבלות הגיל")

        return []
