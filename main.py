from fastapi import FastAPI, Request, Form, UploadFile, File, Depends, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session
import shutil
import os
import uuid
from pathlib import Path
from typing import List
from database import SessionLocal, engine, Base, WindowRequest, WindowImage


BASE_DIR = Path(__file__).resolve().parent

app = FastAPI()

# Database initialization (safe for Vercel)
def init_db():
    try:
        from database import engine, Base
        Base.metadata.create_all(bind=engine)
    except Exception as e:
        print(f"DB Init Warning: {e}")

@app.on_event("startup")
async def startup():
    init_db()

# Mount Static Files
if (BASE_DIR / "static").exists():
    app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

# Only mount uploads if not on Vercel or if it exists
if os.environ.get("VERCEL"):
    UPLOAD_DIR = Path("/tmp/uploads")
    try:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    except:
        pass
else:
    UPLOAD_DIR = Path("uploads")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

if UPLOAD_DIR.exists():
    app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

# Templates
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# Skip redundant dir creation here as it's handled above

# Dependency to get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# Simple in-memory cache to speed up image loading
image_cache = {}

@app.get("/api/proxy-image")
async def proxy_image(url: str):
    import requests
    from fastapi import Response, HTTPException
    
    # 1. Check cache first
    if url in image_cache:
        cached_data = image_cache[url]
        return Response(content=cached_data["content"], media_type=cached_data["media_type"])

    # 2. Convert to direct link if it's a standard view link
    final_url = url
    if "drive.google.com" in url:
        import re
        match = re.search(r'\/d\/(.+?)(?:\/|$|\?)', url) or re.search(r'[?&]id=(.+?)(?:&|$)', url)
        if match:
            final_url = f"https://drive.google.com/uc?export=view&id={match.group(1)}"

    # 3. Fetch with browser-like headers
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }

    try:
        import requests
        res = requests.get(final_url, headers=headers, timeout=15, allow_redirects=True)
        if res.status_code != 200:
            raise HTTPException(status_code=res.status_code, detail=f"Google Drive returned {res.status_code}")
            
        content = res.content
        media_type = res.headers.get("Content-Type", "image/jpeg")
        
        # Save to cache (limit size to ~50 images to avoid memory issues)
        if len(image_cache) > 50:
            image_cache.clear()
        image_cache[url] = {"content": content, "media_type": media_type}
            
        return Response(content=content, media_type=media_type)
    except Exception as e:
        print(f"Proxy Error: {str(e)}")
        # If requests fails or other error, return 400
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/admin", response_class=HTMLResponse)
async def admin_dashboard(request: Request):
    return templates.TemplateResponse("admin.html", {"request": request})

@app.post("/submit")
async def submit_request(
    name: str = Form(...),
    phone: str = Form(...),
    locations: List[str] = Form(...),
    reference_types: List[str] = Form(...),
    images: List[UploadFile] = File(...),
    db: Session = Depends(get_db)
):
    # 1. Create Request
    db_request = WindowRequest(
        customer_name=name,
        phone=phone,
        status="자료업로드"
    )
    db.add(db_request)
    db.commit()
    db.refresh(db_request)

    # 2. Save Images and Link them
    for i, image in enumerate(images):
        file_extension = os.path.splitext(image.filename)[1]
        file_name = f"{uuid.uuid4()}{file_extension}"
        file_path = UPLOAD_DIR / file_name
        
        with file_path.open("wb") as buffer:
            shutil.copyfileobj(image.file, buffer)
            
        db_image = WindowImage(
            request_id=db_request.id,
            image_path=str(file_path).replace("\\", "/"),
            location_type=locations[i],
            reference_type=reference_types[i]
        )
        db.add(db_image)
    
    db.commit()
    
    return JSONResponse(content={"message": "접수가 완료되었습니다.", "id": db_request.id})

@app.get("/api/requests")
async def get_requests(db: Session = Depends(get_db)):
    from sqlalchemy.orm import joinedload
    requests = db.query(WindowRequest).options(joinedload(WindowRequest.images)).order_by(WindowRequest.created_at.desc()).all()
    # Simple serialization for images
    result = []
    for r in requests:
        result.append({
            "id": r.id,
            "customer_name": r.customer_name,
            "phone": r.phone,
            "status": r.status,
            "created_at": r.created_at,
            "image_count": len(r.images)
        })
    return result

@app.get("/api/request/{request_id}")
async def get_request_detail(request_id: int, db: Session = Depends(get_db)):
    from sqlalchemy.orm import joinedload
    req = db.query(WindowRequest).options(joinedload(WindowRequest.images)).filter(WindowRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    
    return {
        "id": req.id,
        "customer_name": req.customer_name,
        "phone": req.phone,
        "status": req.status,
        "memo": req.memo,
        "images": [
            {
                "id": img.id,
                "image_path": img.image_path,
                "location_type": img.location_type,
                "reference_type": img.reference_type,
                "width": img.width,
                "height": img.height
            } for img in req.images
        ]
    }

@app.post("/api/save_image_result/{image_id}")
async def save_image_result(
    image_id: int,
    width: float = Form(None),
    height: float = Form(None),
    db: Session = Depends(get_db)
):
    img = db.query(WindowImage).filter(WindowImage.id == image_id).first()
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    
    if width is not None: img.width = width
    if height is not None: img.height = height
    
    db.commit()
    return {"message": "Success"}


@app.post("/api/analyze/{image_id}")
async def analyze_request(image_id: int, db: Session = Depends(get_db)):
    from utils.image_processing import detect_reference_object
    
    img = db.query(WindowImage).filter(WindowImage.id == image_id).first()
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
        
    # Run Detection
    result = detect_reference_object(img.image_path, img.reference_type)
    
    if result:
        return {"success": True, "box": result}
    else:
        return {"success": False, "message": "Could not detect reference object automatically."}



@app.post("/api/update_request/{request_id}")
async def update_request(
    request_id: int,
    width: float = Form(None),
    height: float = Form(None),
    memo: str = Form(None),
    status: str = Form(None),
    db: Session = Depends(get_db)
):
    req = db.query(WindowRequest).filter(WindowRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, message="Request not found")
    
    if width is not None: req.width = width
    if height is not None: req.height = height
    if memo is not None: req.memo = memo
    if status is not None: req.status = status
    
    db.commit()
    return {"message": "Updated successfully"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
