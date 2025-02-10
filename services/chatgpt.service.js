const axios = require('axios');
require('dotenv').config();

class ChatGPTService {
  constructor() {
    this.apiKey = process.env.CHAT_GPT_API_KEY;
  }

  async analyzeEventDescription(description) {
    try {
      console.log('מתחיל ניתוח תיאור אירוע:', description);
      
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content: `אתה עוזר שמנתח תיאורי אירועים ומפיק מהם שדות רלוונטיים בפורמט JSON.
              עליך לחלץ כמה שיותר מידע מהטקסט ולהחזיר אובייקט JSON עם השדות הבאים:
              - location: מיקום האירוע (חובה למלא)
              - eventType: סוג האירוע (למשל: מסיבה, הופעה, וכו')
              - targetAudience: קהל היעד
              - specialRequirements: דרישות מיוחדות
              - expectedAttendees: מספר משתתפים צפוי
              - dresscode: קוד לבוש
              - additionalInfo: מידע נוסף חשוב
              
              אם חסר מידע בשדה מסוים, נסה להסיק אותו מההקשר.
              אם באמת אין מידע, השאר את השדה ריק.
              חשוב להחזיר תמיד ערך כלשהו בשדה location.`
            },
            {
              role: "user",
              content: `נתח את תיאור האירוע הבא והפק ממנו את השדות המבוקשים: ${description}`
            }
          ],
          temperature: 0.7,
          max_tokens: 500
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      let suggestedFields;
      try {
        const content = response.data.choices[0].message.content;
        console.log('תשובה מ-ChatGPT:', content);
        
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          suggestedFields = JSON.parse(jsonMatch[0]);
          
          // וידוא שיש ערך במיקום
          if (!suggestedFields.location) {
            suggestedFields.location = 'לא צוין';
          }
          
          console.log('שדות שנותחו:', suggestedFields);
        } else {
          throw new Error('לא נמצא JSON בתשובה');
        }
      } catch (parseError) {
        console.error('שגיאה בפרסור התשובה:', parseError);
        suggestedFields = {
          location: 'לא צוין',
          eventType: '',
          targetAudience: '',
          specialRequirements: '',
          expectedAttendees: null,
          dresscode: '',
          additionalInfo: ''
        };
      }

      return suggestedFields;
    } catch (error) {
      console.error('שגיאה בניתוח תיאור האירוע:', error);
      throw error;
    }
  }
}

module.exports = new ChatGPTService(); 