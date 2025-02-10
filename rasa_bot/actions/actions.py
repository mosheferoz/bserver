from typing import Any, Text, Dict, List
from rasa_sdk import Action, Tracker
from rasa_sdk.executor import CollectingDispatcher
from rasa_sdk.events import SlotSet
import requests
import json
import logging

logger = logging.getLogger(__name__)

class ActionGetEventInfo(Action):
    def name(self) -> Text:
        return "action_get_event_info"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        try:
            # קבלת מידע על האירוע מהשרת
            event_id = tracker.get_slot("event_id")
            if not event_id:
                dispatcher.utter_message(text="מצטער, אין לי מידע על האירוע כרגע.")
                return []

            # כאן תהיה הקריאה לשרת לקבלת מידע על האירוע
            # response = requests.get(f"http://localhost:10000/api/events/{event_id}")
            # event_data = response.json()

            # לבינתיים נשתמש במידע מהסלוטים
            event_name = tracker.get_slot("event_name")
            event_date = tracker.get_slot("event_date")
            event_location = tracker.get_slot("event_location")

            message = f"האירוע {event_name} יתקיים בתאריך {event_date} ב{event_location}."
            dispatcher.utter_message(text=message)

            return []
        except Exception as e:
            logger.error(f"Error in action_get_event_info: {e}")
            dispatcher.utter_message(text="מצטער, נתקלתי בבעיה בקבלת המידע.")
            return []

class ActionGetAgentInfo(Action):
    def name(self) -> Text:
        return "action_get_agent_info"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        try:
            agent_name = tracker.get_slot("agent_name")
            agent_style = tracker.get_slot("agent_style")
            agent_expertise = tracker.get_slot("agent_expertise")

            message = f"אני {agent_name}, {agent_style} עם התמחות ב{agent_expertise}."
            dispatcher.utter_message(text=message)

            return []
        except Exception as e:
            logger.error(f"Error in action_get_agent_info: {e}")
            dispatcher.utter_message(text="מצטער, נתקלתי בבעיה.")
            return []

class ActionSetEventContext(Action):
    def name(self) -> Text:
        return "action_set_event_context"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        try:
            event_data = tracker.get_slot("event_data")
            if not event_data:
                return []

            # המרת המידע למילון אם הוא מגיע כמחרוזת
            if isinstance(event_data, str):
                event_data = json.loads(event_data)

            events = []
            # עדכון כל הסלוטים הרלוונטיים
            for key, value in event_data.items():
                events.append(SlotSet(key, value))

            return events
        except Exception as e:
            logger.error(f"Error in action_set_event_context: {e}")
            return []

class ActionHandleCustomField(Action):
    def name(self) -> Text:
        return "action_handle_custom_field"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        try:
            custom_fields = tracker.get_slot("custom_fields")
            field_name = tracker.get_slot("requested_field")

            if not custom_fields or not field_name:
                dispatcher.utter_message(text="מצטער, אין לי מידע על השדה המבוקש.")
                return []

            # המרת המידע למילון אם הוא מגיע כמחרוזת
            if isinstance(custom_fields, str):
                custom_fields = json.loads(custom_fields)

            if field_name in custom_fields:
                value = custom_fields[field_name]
                dispatcher.utter_message(text=f"{field_name}: {value}")
            else:
                dispatcher.utter_message(text=f"מצטער, אין לי מידע על {field_name}.")

            return []
        except Exception as e:
            logger.error(f"Error in action_handle_custom_field: {e}")
            dispatcher.utter_message(text="מצטער, נתקלתי בבעיה בטיפול בבקשה.")
            return [] 