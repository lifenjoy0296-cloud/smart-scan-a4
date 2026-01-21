import numpy as np
from PIL import Image

def detect_reference_object(image_path, ref_type):
    """
    Simulates detection of reference object using Pillow for size.
    Returns (x, y, w, h) of the bounding box.
    """
    try:
        with Image.open(image_path) as img:
            w, h = img.size
        
        # Dummy box in the center
        center_x, center_y = w // 2, h // 2
        box_w, box_h = w // 5, h // 5
        
        return {
            "x": center_x - box_w // 2,
            "y": center_y - box_h // 2,
            "w": box_w,
            "h": box_h
        }
    except Exception as e:
        print(f"Error in image processing: {e}")
        return None
