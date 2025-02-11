#!/bin/bash

# פונקציה לבדיקת שגיאות
check_error() {
    if [ $? -ne 0 ]; then
        echo "שגיאה: $1"
        exit 1
    fi
}

# בדיקה אם conda מותקן
if ! command -v conda &> /dev/null; then
    echo "שגיאה: conda לא מותקן. אנא התקן את Miniconda או Anaconda"
    exit 1
fi

# יצירת והפעלת סביבת conda
echo "מגדיר סביבת Rasa..."
CONDA_ENV_NAME="rasa_env"

# מחיקת סביבה קיימת אם יש
conda env remove -n $CONDA_ENV_NAME -y

echo "יוצר סביבה חדשה..."
conda create -n $CONDA_ENV_NAME python=3.8 -y
check_error "נכשל ביצירת סביבת conda"

echo "מפעיל סביבת conda..."
eval "$(conda shell.bash hook)"
conda activate $CONDA_ENV_NAME
check_error "נכשל בהפעלת סביבת conda"

echo "מתקין חבילות בסיסיות..."
conda install -y numpy=1.23.5 scikit-learn=1.1.3
check_error "נכשל בהתקנת חבילות בסיסיות"

echo "מתקין spacy..."
conda install -y -c conda-forge spacy=3.7.2
python -m spacy download en_core_web_sm
check_error "נכשל בהתקנת spacy"

echo "מתקין Rust compiler..."
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
check_error "נכשל בהתקנת Rust"

echo "מתקין tensorflow..."
conda install -y -c apple tensorflow-deps
python -m pip install tensorflow-macos==2.12.0
check_error "נכשל בהתקנת tensorflow"

echo "מתקין transformers..."
pip install transformers==4.46.3
check_error "נכשל בהתקנת transformers"

echo "מתקין חבילות Rasa..."
pip install -r requirements.txt
check_error "נכשל בהתקנת חבילות Rasa"

echo "מאמן את מודל Rasa..."
rasa train
check_error "נכשל באימון מודל Rasa"

# הפעלת שרת Rasa
echo "מפעיל שרת Rasa..."
rasa run --enable-api --cors "*" 