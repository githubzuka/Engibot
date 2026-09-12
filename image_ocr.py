import json
import os
import sys

try:
    from PIL import Image
    import pytesseract
except ImportError as error:
    print(json.dumps({"error": f"Missing OCR package: {error}"}))
    sys.exit(2)

if not os.environ.get('TESSERACT_CMD'):
    windows_tesseract = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
    if os.path.exists(windows_tesseract):
        pytesseract.pytesseract.tesseract_cmd = windows_tesseract
elif os.path.exists(os.environ['TESSERACT_CMD']):
    pytesseract.pytesseract.tesseract_cmd = os.environ['TESSERACT_CMD']

image = Image.open(sys.argv[1])
text = pytesseract.image_to_string(image).strip()
print(json.dumps({"text": text, "width": image.width, "height": image.height}))
