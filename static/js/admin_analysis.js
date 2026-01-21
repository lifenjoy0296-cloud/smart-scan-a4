const canvas = document.getElementById('editorCanvas');
const ctx = canvas.getContext('2d');
const container = document.getElementById('canvasContainer');

let currentImage = null;
let currentRequestId = null;
let currentScale = 1;
let offset = { x: 0, y: 0 };
let isDragging = false;
let startPos = { x: 0, y: 0 };

let mode = 'select'; // select, ref, measure
let previousMode = 'select'; // for spacebar return
let refBox = null; // {x, y, w, h}
let isRefLocked = false;
let measureLine = null; // {x1, y1, x2, y2}

let currentRefType = 'A4';
let currentImages = []; // List of image objects
let selectedImageId = null;

// Helper to convert Google Drive Link to a Proxy Link through our server
function getDirectDriveUrl(url) {
    if (!url || typeof url !== 'string') return '';
    // Use our server-side proxy to bypass Google Drive's CORS/Loading issues
    return `/api/proxy-image?url=${encodeURIComponent(url)}`;
}

// Init
function init() {
    loadRequests();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Mouse Events
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel);

    // Keyboard Events
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
}

function onKeyDown(e) {
    if (e.code === 'Space' && (mode === 'ref' || mode === 'measure')) {
        e.preventDefault();
        previousMode = mode;
        setTool('select');
    }
}

function onKeyUp(e) {
    if (e.code === 'Space' && mode === 'select' && previousMode !== 'select') {
        setTool(previousMode);
        previousMode = 'select';
    }
}

const GAS_URL = "https://script.google.com/macros/s/AKfycbxDKV1RBlLvrYnTLqytBJKdgu_WdBMmAU03na0_8GHvTRF9DhcL38tYdQA-6sIB5jMVBw/exec";

// Helper to find value from object even if key name is slightly different
function findVal(obj, keys) {
    if (!obj) return null;
    for (let key of keys) {
        if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
    }
    // Deep search (case-insensitive substring match)
    const objKeys = Object.keys(obj);
    for (let k of objKeys) {
        for (let target of keys) {
            if (k.toLowerCase().includes(target.toLowerCase()) || target.toLowerCase().includes(k.toLowerCase())) {
                if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
            }
        }
    }
    return null;
}

const NAME_KEYS = ["customer_name", "성함", "이름", "고객명", "고객"];
const PHONE_KEYS = ["phone", "연락처", "전화번호", "휴대폰"];
const LOC_KEYS = ["location_type", "시공위치", "위치", "장소"];
const REF_KEYS = ["reference_type", "기준물체 종류", "기준", "기준물체"];
const STATUS_KEYS = ["status", "상태", "진행상태"];
const IMG_KEYS = ["image_path", "구글 드라이브 파일 링크", "사진", "이미지", "파일링크", "drive"];
const MEMO_KEYS = ["memo", "메모", "특이사항"];
const DATE_KEYS = ["created_at", "날짜", "등록일"];

let allRawData = []; // To store ungrouped data for lookup

async function loadRequests() {
    const list = document.getElementById('requestList');
    try {
        const timestamp = new Date().getTime();
        const fetchUrl = `${GAS_URL}?t=${timestamp}`;
        console.log("Fetching from GAS (Cache-busting):", fetchUrl);
        const res = await fetch(fetchUrl);
        const data = await res.json();
        allRawData = data;
        console.log("GAS JSON Data:", data);

        list.innerHTML = '';

        // Grouping Logic: Group by Name + Phone + Date(minute level)
        const groups = {};
        data.forEach(req => {
            const name = findVal(req, NAME_KEYS) || "이름없음";
            const phone = findVal(req, PHONE_KEYS) || "000";
            const date = new Date(findVal(req, DATE_KEYS));
            // Group by name, phone and same 5-minute window
            const timeKey = `${date.getFullYear()}${date.getMonth()}${date.getDate()}${date.getHours()}${Math.floor(date.getMinutes() / 5)}`;
            const groupKey = `${name}_${phone}_${timeKey}`;

            if (!groups[groupKey]) {
                groups[groupKey] = {
                    info: req,
                    images: []
                };
            }
            groups[groupKey].images.push(req);
        });

        Object.values(groups).forEach((group, index) => {
            const req = group.info;
            const name = findVal(req, NAME_KEYS) || "이름없음";
            const location = findVal(req, LOC_KEYS) || "위치없음";
            const status = findVal(req, STATUS_KEYS) || "자료업로드";
            const dateStr = findVal(req, DATE_KEYS) || new Date();
            const imgCount = group.images.length;

            const li = document.createElement('li');
            li.className = 'p-4 hover:bg-blue-50 cursor-pointer border-b transition-colors';
            li.innerHTML = `
                <div class="flex justify-between items-start">
                    <div>
                        <p class="font-bold text-gray-800">${name} <span class="text-blue-500 text-xs">[${imgCount}]</span></p>
                        <p class="text-xs text-gray-500">${location} 외</p>
                    </div>
                    <span class="text-xs px-2 py-1 rounded-full ${getStatusColor(status)}">${status}</span>
                </div>
                <p class="text-xs text-gray-400 mt-1">${new Date(dateStr).toLocaleString()}</p>
            `;
            li.onclick = () => loadRequestDetail(group);
            list.appendChild(li);

            if (index === 0 && !selectedImageId) {
                loadRequestDetail(group);
            }
        });
    } catch (e) {
        console.error("Data Load Error:", e);
    }
}

function getStatusColor(status) {
    if (status === '자료업로드') return 'bg-gray-200 text-gray-700';
    if (status === '분석완료') return 'bg-blue-100 text-blue-700';
    if (status === '견적완료') return 'bg-green-100 text-green-700';
    return 'bg-gray-100';
}

async function loadRequestDetail(group) {
    const mainData = group.info;
    currentRequestId = mainData.id;
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('workspace').classList.remove('hidden');

    const name = findVal(mainData, NAME_KEYS) || "-";
    const phone = findVal(mainData, PHONE_KEYS) || "-";
    const status = findVal(mainData, STATUS_KEYS) || "자료업로드";
    const memo = findVal(mainData, MEMO_KEYS) || "";

    document.getElementById('infoNamePhone').innerText = `${name} / ${phone}`;
    document.getElementById('statusSelect').value = status;
    document.getElementById('memoText').value = memo;

    // Load multiple images from the group
    currentImages = group.images.map(img => ({
        id: img.id,
        image_path: findVal(img, IMG_KEYS),
        location_type: findVal(img, LOC_KEYS),
        reference_type: findVal(img, REF_KEYS),
        width: img.width || img["가로 mm"] || 0,
        height: img.height || img["세로 mm"] || 0
    }));

    renderGallery();
    if (currentImages.length > 0) {
        selectImage(currentImages[0].id);
    }
}

function toggleRefLock() {
    isRefLocked = !isRefLocked;
    const btn = document.getElementById('lockRefBtn');
    if (isRefLocked) {
        btn.innerText = '🔒 기준물체 잠금됨';
        btn.classList.replace('bg-gray-200', 'bg-green-600');
        btn.classList.replace('text-gray-700', 'text-white');
    } else {
        btn.innerText = '🔓 잠금해제 상태';
        btn.classList.replace('bg-green-600', 'bg-gray-200');
        btn.classList.replace('text-white', 'text-gray-700');
    }
}

// --- Smart Zoom Features ---
function resetZoom() {
    currentScale = 1.0;
    offset.x = 0;
    offset.y = 0;
    draw();
}

function zoomToPoint(targetX, targetY) {
    // Zoom in to 4.0x scale around the clicked point
    const targetScale = 4.0;

    // Calculate new position to center the target point
    // targetX/Y are in image-space pixels
    offset.x = (canvas.width / 2) - (targetX * targetScale);
    offset.y = (canvas.height / 2) - (targetY * targetScale);
    currentScale = targetScale;

    draw();
}

function renderGallery() {
    const gallery = document.getElementById('imageGallery');
    gallery.innerHTML = '';
    currentImages.forEach(img => {
        const thumb = document.createElement('div');
        const isSelected = img.id === selectedImageId;
        thumb.className = `flex-shrink-0 w-20 h-20 rounded border-2 cursor-pointer transition-all overflow-hidden ${isSelected ? 'border-blue-500 scale-105' : 'border-transparent opacity-60 hover:opacity-100'}`;
        const directUrl = getDirectDriveUrl(img.image_path);
        thumb.innerHTML = `<img src="${directUrl}" class="w-full h-full object-cover">`;
        thumb.onclick = () => selectImage(img.id);
        gallery.appendChild(thumb);
    });
}

// Helper to control loading overlay
function showLoading(msg = "사진 불러오는 중...") {
    const overlay = document.getElementById('imageLoadingOverlay');
    overlay.querySelector('p').innerText = msg;
    overlay.classList.remove('hidden');
}

function hideLoading() {
    document.getElementById('imageLoadingOverlay').classList.add('hidden');
}

function selectImage(id) {
    selectedImageId = id;
    const imgData = currentImages.find(i => i.id === id);
    if (!imgData) return;

    // Update Image Info
    document.getElementById('infoLocationRef').innerText = `${imgData.location_type} / ${imgData.reference_type}`;
    document.getElementById('resWidth').value = imgData.width || '';
    document.getElementById('resHeight').value = imgData.height || '';
    currentRefType = imgData.reference_type;

    // Reset Canvas & Load Image
    const img = new Image();
    const directUrl = getDirectDriveUrl(imgData.image_path);
    console.log("Loading Image URL:", directUrl);

    showLoading("사진 불러오는 중...");

    img.crossOrigin = "anonymous";
    img.src = directUrl;

    img.onload = () => {
        console.log("Image loaded successfully with CORS");
        hideLoading();
        currentImage = img;
        resizeCanvas();
        fitImageToCanvas();
        refBox = null;
        measureLine = null;
        // Reset measurement slots
        ['w1', 'w2', 'w3', 'h1', 'h2', 'h3'].forEach(id => document.getElementById(id).value = '');
        updateAverages();
        draw();
    };

    img.onerror = () => {
        console.warn("Image load failed with CORS. Trying fallback...");
        const fallbackImg = new Image();
        fallbackImg.src = directUrl;
        fallbackImg.onload = () => {
            console.log("Image loaded (CORS Fallback)");
            hideLoading();
            currentImage = fallbackImg;
            resizeCanvas();
            fitImageToCanvas();
            draw();
        };
        fallbackImg.onerror = () => {
            console.error("Critical Image Failure:", directUrl);
            hideLoading();
            alert("이미지를 불러올 수 없습니다. 구글 드라이브의 '링크 공유'가 '모든 사용자에게 공개'로 되어 있는지 확인해 주세요.");
        };
    };
    renderGallery();
}

function resizeCanvas() {
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    draw();
}

function fitImageToCanvas() {
    if (!currentImage) return;
    const scaleX = canvas.width / currentImage.width;
    const scaleY = canvas.height / currentImage.height;
    currentScale = Math.min(scaleX, scaleY) * 0.9;
    offset.x = (canvas.width - currentImage.width * currentScale) / 2;
    offset.y = (canvas.height - currentImage.height * currentScale) / 2;
}

// Drawing Logic
function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!currentImage) return;

    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(currentScale, currentScale);

    ctx.drawImage(currentImage, 0, 0);

    // Draw Ref Box (Green)
    if (refBox) {
        ctx.strokeStyle = '#00FF00';
        ctx.lineWidth = 3 / currentScale;
        ctx.strokeRect(refBox.x, refBox.y, refBox.w, refBox.h);
        ctx.fillStyle = 'rgba(0, 255, 0, 0.2)';
        ctx.fillRect(refBox.x, refBox.y, refBox.w, refBox.h);
    }

    // Draw Measure Line (Red)
    if (measureLine) {
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = 3 / currentScale;
        ctx.beginPath();
        ctx.moveTo(measureLine.x1, measureLine.y1);
        ctx.lineTo(measureLine.x2, measureLine.y2);
        ctx.stroke();

        ctx.fillStyle = '#FF0000';
        ctx.beginPath();
        ctx.arc(measureLine.x1, measureLine.y1, 5 / currentScale, 0, Math.PI * 2);
        ctx.arc(measureLine.x2, measureLine.y2, 5 / currentScale, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.restore();
}

// Interaction
function setTool(t) {
    mode = t;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('ring-2', 'ring-blue-500'));
    const btn = document.querySelector(`[data-tool="${t}"]`);
    if (btn) btn.classList.add('ring-2', 'ring-blue-500');
}

function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (e.clientX - rect.left - offset.x) / currentScale,
        y: (e.clientY - rect.top - offset.y) / currentScale
    };
}

function onMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const pos = getMousePos(e);

    isDragging = true;
    startPos = pos;

    if (mode === 'ref') {
        // Prevent reset if locked
        if (isRefLocked && refBox) return;

        // If not zoomed in, zoom in first to the click area
        if (currentScale < 2.0) {
            zoomToPoint(pos.x, pos.y);
            isDragging = false; // Don't start drawing immediately on zoom click
            return;
        }
        refBox = { x: pos.x, y: pos.y, w: 0, h: 0 };
    } else if (mode === 'measure') {
        measureLine = { x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y };
    }
}

function onMouseMove(e) {
    if (!isDragging) return;
    const pos = getMousePos(e);

    if (mode === 'select') {
        offset.x += e.movementX;
        offset.y += e.movementY;
    } else if (mode === 'ref') {
        refBox.w = pos.x - startPos.x;
        refBox.h = pos.y - startPos.y;
    } else if (mode === 'measure') {
        measureLine.x2 = pos.x;
        measureLine.y2 = pos.y;
    }
    draw();
}

function onMouseUp(e) {
    isDragging = false;
    if (refBox && (refBox.w < 0 || refBox.h < 0)) {
        if (refBox.w < 0) { refBox.x += refBox.w; refBox.w = Math.abs(refBox.w); }
        if (refBox.h < 0) { refBox.y += refBox.h; refBox.h = Math.abs(refBox.h); }
    }
    draw();
}

function onWheel(e) {
    e.preventDefault();
    const zoomIntensity = 0.1;
    const delta = e.deltaY > 0 ? -zoomIntensity : zoomIntensity;
    currentScale *= (1 + delta);
    draw();
}

function calculateRealSize() {
    if (!refBox || !measureLine) {
        alert("기준 물체(초록박스)와 측정 선(빨간선)을 모두 그려주세요.");
        return;
    }

    showLoading("치수 계산 중...");

    setTimeout(() => {
        // For better accuracy, we calculate pixels per cm using the longer dimension of the refBox
        // (A4 is 29.7 x 21.0, Credit Card is 8.56 x 5.4)
        let refRealLong, refRealShort;
        if (currentRefType === 'CREDIT_CARD') {
            refRealLong = 8.56;
            refRealShort = 5.4;
        } else {
            refRealLong = 29.7;
            refRealShort = 21.0;
        }

        // Determine if drawn refBox is horizontal or vertical to use correct side for calibration
        const isRefHorizontal = refBox.w > refBox.h;
        const calibPx = isRefHorizontal ? refBox.w : refBox.h;
        const calibReal = isRefHorizontal ? refRealLong : refRealLong; // We usually align long side

        // Actually, let's use the intended long side specifically
        const pixelsPerCm = calibPx / refRealLong;

        const dx = measureLine.x2 - measureLine.x1;
        const dy = measureLine.y2 - measureLine.y1;
        const linePx = Math.sqrt(dx * dx + dy * dy);

        // Convert to mm and round with decimals for precision
        const realMm = (linePx / pixelsPerCm) * 10;
        const finalVal = Math.round(realMm);

        // Simple heuristic: wider than tall -> horizontal
        if (Math.abs(dx) > Math.abs(dy)) {
            // Width slot
            if (!document.getElementById('w1').value) document.getElementById('w1').value = finalVal;
            else if (!document.getElementById('w2').value) document.getElementById('w2').value = finalVal;
            else document.getElementById('w3').value = finalVal;
        } else {
            // Height slot
            if (!document.getElementById('h1').value) document.getElementById('h1').value = finalVal;
            else if (!document.getElementById('h2').value) document.getElementById('h2').value = finalVal;
            else document.getElementById('h3').value = finalVal;
        }
        updateAverages();
        hideLoading();
    }, 300);
}

function updateAverages() {
    function calcAvg(ids) {
        const vals = ids.map(id => parseFloat(document.getElementById(id).value) || 0).filter(v => v > 0);
        if (vals.length === 0) return 0;
        return Math.round(vals.reduce((a, b) => a + b) / vals.length);
    }

    const avgW = calcAvg(['w1', 'w2', 'w3']);
    const avgH = calcAvg(['h1', 'h2', 'h3']);

    document.getElementById('avgWidth').innerText = avgW;
    document.getElementById('avgHeight').innerText = avgH;

    // Set hidden inputs for saving
    document.getElementById('resWidth').value = avgW;
    document.getElementById('resHeight').value = avgH;
}

async function saveResult() {
    if (!currentRequestId || !selectedImageId) return;

    const currentImgData = currentImages.find(i => i.id === selectedImageId);
    if (!currentImgData) return;

    const GAS_URL = "https://script.google.com/macros/s/AKfycbxX01j0sgpIp7RYQSAjfIXcrmKAw9B_sIpdZM9UkM0yziMd5M4qAOxYa8VN-TP9RcZlHw/exec";

    // Overall request info label from UI
    const namePhone = document.getElementById('infoNamePhone').innerText.split(' / ');
    const name = namePhone[0];
    const phone = namePhone[1];

    showLoading("데이터 저장 중...");

    const payload = {
        type: "ADMIN_SAVE",
        name: name,
        phone: phone,
        location: currentImgData.location_type,
        width: document.getElementById('resWidth').value,
        height: document.getElementById('resHeight').value,
        status: document.getElementById('statusSelect').value,
        memo: document.getElementById('memoText').value
    };

    try {
        await fetch(GAS_URL, {
            method: 'POST',
            mode: 'no-cors',
            body: JSON.stringify(payload)
        });

        // Also update local DB for persistence during current session
        const localFormData = new FormData();
        localFormData.append('memo', payload.memo);
        localFormData.append('status', payload.status);
        await fetch(`/api/update_request/${currentRequestId}`, { method: 'POST', body: localFormData });

        hideLoading();
        alert("구글 시트 저장 및 파일명 변경이 완료되었습니다.");
        loadRequests();
    } catch (e) {
        console.error(e);
        hideLoading();
        alert("저장 중 오류가 발생했습니다.");
    }
}

async function autoDetect() {
    if (!selectedImageId) return;

    showLoading("AI 자동분석 중...");

    try {
        const res = await fetch(`/api/analyze/${selectedImageId}`, { method: 'POST' });
        const data = await res.json();

        if (data.success && data.box) {
            refBox = {
                x: data.box.x,
                y: data.box.y,
                w: data.box.w,
                h: data.box.h
            };
            draw();
            hideLoading();
            alert("기준 물체가 감지되었습니다.");
        } else {
            hideLoading();
            alert("자동 감지 실패: 직접 그려주세요.");
        }
    } catch (e) {
        console.error(e);
        hideLoading();
        alert("분석 중 오류가 발생했습니다.");
    }
}

init();
