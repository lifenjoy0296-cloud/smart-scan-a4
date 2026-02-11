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

// Helper to get a fast thumbnail URL from Google Drive ID
function getThumbnailUrl(url_or_id) {
    if (!url_or_id) return '';
    let id = url_or_id;
    // Extract ID if it's a full URL
    if (url_or_id.includes('id=')) {
        id = url_or_id.split('id=')[1].split('&')[0];
    } else if (url_or_id.includes('/d/')) {
        id = url_or_id.split('/d/')[1].split('/')[0];
    }
    // Google Drive native thumbnail endpoint (sz=w200 for 200px width)
    return `https://drive.google.com/thumbnail?id=${id}&sz=w200`;
}

// Helper to convert Google Drive Link to a Proxy Link through our server
const CONVEX_URL = "https://your-convex-app-url.convex.cloud"; // USER: Same as index.html
let convexClient;

async function initConvex() {
    try {
        const { ConvexClient } = await import("https://unpkg.com/convex@1.11.0/dist/browser/index.js");
        convexClient = new ConvexClient(CONVEX_URL);
        console.log("Admin: Convex Client Initialized");
        loadRequestsConvex(); // Use Convex loading
    } catch (err) {
        console.error("Failed to load Convex:", err);
    }
}

// Redirect old init to new init
const originalInit = init;
init = function () {
    originalInit();
    initConvex();
};

async function loadRequestsConvex() {
    if (!convexClient) return;
    const list = document.getElementById('requestList');

    // Use Convex watch query if possible, or simple query
    try {
        // For simplicity in this script, we'll fetch once or subscribe
        const requests = await convexClient.query("requests:list");
        console.log("Convex Data:", requests);

        list.innerHTML = '';

        requests.forEach((req, index) => {
            const name = req.customer_name || "이름없음";
            const status = req.status || "자료업로드";
            const dateStr = req.createdAt;
            const imgCount = req.imageCount || 0;

            const li = document.createElement('li');
            li.className = 'p-4 hover:bg-blue-50 cursor-pointer border-b transition-colors';
            li.innerHTML = `
                <div class="flex justify-between items-start">
                    <div>
                        <p class="font-bold text-gray-800">${name} <span class="text-blue-500 text-xs">[${imgCount}]</span></p>
                        <p class="text-xs text-gray-500">접수번호: ${req._id.substring(0, 8)}</p>
                    </div>
                    <span class="text-xs px-2 py-1 rounded-full ${getStatusColor(status)}">${status}</span>
                </div>
                <p class="text-xs text-gray-400 mt-1">${new Date(dateStr).toLocaleString()}</p>
            `;
            li.onclick = () => loadRequestDetailConvex(req._id);
            list.appendChild(li);

            if (index === 0 && !selectedImageId) {
                loadRequestDetailConvex(req._id);
            }
        });
    } catch (err) {
        console.error("Convex Load Error:", err);
    }
}

async function loadRequestDetailConvex(requestId) {
    if (!convexClient) return;
    currentRequestId = requestId;
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('workspace').classList.remove('hidden');

    const data = await convexClient.query("requests:getDetail", { requestId });
    if (!data) return;

    document.getElementById('infoNamePhone').innerText = `${data.customer_name} / ${data.phone}`;
    document.getElementById('statusSelect').value = data.status;
    document.getElementById('memoText').value = data.memo || "";

    currentImages = data.images.map(img => ({
        id: img._id,
        image_path: img.url, // Convex URL
        location_type: img.location,
        reference_type: img.refType,
        width: img.width || 0,
        height: img.height || 0
    }));

    renderGallery();
    if (currentImages.length > 0) {
        selectImage(currentImages[0].id);
    }
}

// Redirect old save
async function saveResult() {
    if (!currentRequestId || !selectedImageId || !convexClient) return;

    showLoading("데이터 저장 중...");

    try {
        const status = document.getElementById('statusSelect').value;
        const memo = document.getElementById('memoText').value;
        const width = parseFloat(document.getElementById('resWidth').value);
        const height = parseFloat(document.getElementById('resHeight').value);

        // 1. Update Request
        await convexClient.mutation("requests:updateStatus", {
            requestId: currentRequestId,
            status,
            memo
        });

        // 2. Update Image Result
        await convexClient.mutation("images:updateImageResult", {
            imageId: selectedImageId,
            width,
            height
        });

        hideLoading();
        alert("분석 결과가 저장되었습니다. (Convex)");
        loadRequestsConvex();
    } catch (err) {
        console.error(err);
        hideLoading();
        alert("저장 중 오류가 발생했습니다.");
    }
}

async function autoDetect() {
    if (!selectedImageId || !convexClient) return;
    showLoading("AI 자동분석 중...");
    try {
        const data = await convexClient.action("images:analyzeImage", { imageId: selectedImageId });
        if (data.success && data.box) {
            refBox = data.box;
            draw();
            hideLoading();
            alert("기준 물체가 감지되었습니다.");
        }
    } catch (err) {
        console.error(err);
        hideLoading();
        alert("분석 실패.");
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
        id: findVal(img, ID_KEYS) || img.id,
        image_path: findVal(img, IMG_KEYS),
        location_type: findVal(img, LOC_KEYS),
        reference_type: findVal(img, REF_KEYS),
        width: findVal(img, WIDTH_KEYS) || 0,
        height: findVal(img, HEIGHT_KEYS) || 0
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
        thumb.className = `flex-shrink-0 w-20 h-20 rounded border-2 cursor-pointer transition-all overflow-hidden bg-gray-200 ${isSelected ? 'border-blue-500 scale-105' : 'border-transparent opacity-70 hover:opacity-100'}`;

        // Use fast thumbnail instead of proxied full image for gallery
        const thumbUrl = getThumbnailUrl(img.image_path);
        const directUrl = getDirectDriveUrl(img.image_path); // Fallback if thumbnail fails

        thumb.innerHTML = `<img src="${thumbUrl}" class="w-full h-full object-cover" loading="lazy" onerror="this.onerror=null; this.src='${directUrl}';">`;

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
    currentRefType = imgData.reference_type;

    // Reset Canvas & Load Image
    const img = new Image();
    const directUrl = getDirectDriveUrl(imgData.image_path);

    showLoading("사진 불러오는 중...");

    img.crossOrigin = "anonymous";
    img.src = directUrl;

    img.onload = () => {
        hideLoading();
        currentImage = img;
        resizeCanvas();
        fitImageToCanvas();

        refBox = null;
        measureLine = null;

        // Populate existing measurements if available
        ['w1', 'w2', 'w3', 'h1', 'h2', 'h3'].forEach(id => document.getElementById(id).value = '');

        if (imgData.width && imgData.width > 0) document.getElementById('w1').value = imgData.width;
        if (imgData.height && imgData.height > 0) document.getElementById('h1').value = imgData.height;

        updateAverages();
        draw();
    };

    img.onerror = () => {
        const fallbackImg = new Image();
        fallbackImg.src = directUrl;
        fallbackImg.onload = () => {
            hideLoading();
            currentImage = fallbackImg;
            resizeCanvas();
            fitImageToCanvas();
            draw();
        };
        fallbackImg.onerror = () => {
            hideLoading();
            alert("이미지를 불러올 수 없습니다.");
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
    if (!currentImage) return;

    // Clear and draw background
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#1e293b"; // Slate-800
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(currentScale, currentScale);

    // 1. Draw Image
    ctx.drawImage(currentImage, 0, 0);

    // 2. Draw Reference Box
    if (refBox) {
        ctx.strokeStyle = '#22c55e'; // Green-500
        ctx.lineWidth = 3 / currentScale;
        ctx.strokeRect(refBox.x, refBox.y, refBox.w, refBox.h);
        ctx.fillStyle = 'rgba(34, 197, 94, 0.2)';
        ctx.fillRect(refBox.x, refBox.y, refBox.w, refBox.h);
    }

    // 3. Draw Measurement Line
    if (measureLine) {
        ctx.strokeStyle = '#ef4444'; // Red-500
        ctx.lineWidth = 3 / currentScale;
        ctx.beginPath();
        ctx.moveTo(measureLine.x1, measureLine.y1);
        ctx.lineTo(measureLine.x2, measureLine.y2);
        ctx.stroke();

        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(measureLine.x1, measureLine.y1, 5 / currentScale, 0, Math.PI * 2);
        ctx.arc(measureLine.x2, measureLine.y2, 5 / currentScale, 0, Math.PI * 2);
        ctx.fill();
    }

    // 4. Visual Overlays (Always show Info, show Dimensions if available)
    drawOverlaysToCtx(ctx, canvas.width, canvas.height, true);

    ctx.restore();
}

// Interaction
function setTool(t) {
    mode = t;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('ring-2', 'ring-blue-500'));
    const btn = document.querySelector(`[data-tool="${t}"]`);
    if (btn) btn.classList.add('ring-2', 'ring-blue-500');
    hideFloatingBtn();
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
        hideFloatingBtn();
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

    if (mode === 'measure' && measureLine) {
        // Show floating button at mouse position
        showFloatingBtn(e.clientX, e.clientY);
    }

    draw();
}

function showFloatingBtn(x, y) {
    const btn = document.getElementById('floatingCalcBtn');
    if (!btn) return;

    // Convert viewport coordinates to container-relative coordinates
    const rect = container.getBoundingClientRect();
    let relX = x - rect.left;
    let relY = y - rect.top;

    // Add some offset so it doesn't block the end point
    relX += 15;
    relY += 15;

    // Keep within container bounds
    if (relX + 100 > rect.width) relX -= 120; // Flip left if too far right
    if (relY + 40 > rect.height) relY -= 60;  // Flip up if too far down

    btn.style.left = relX + 'px';
    btn.style.top = relY + 'px';
    btn.classList.remove('hidden');
}

function hideFloatingBtn() {
    const btn = document.getElementById('floatingCalcBtn');
    if (btn) btn.classList.add('hidden');
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
    function parseToNumber(val) {
        if (!val) return 0;
        // Strip commas, units, and non-numeric chars for safe calculation
        const clean = String(val).replace(/,/g, '').replace(/[a-zA-Z가-힣]/g, '').trim();
        return parseFloat(clean) || 0;
    }

    function calcAvg(ids) {
        const vals = ids.map(id => parseToNumber(document.getElementById(id).value)).filter(v => v > 0);
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

    // Redraw to reflect changes in overlay info box
    draw();
}

async function saveResult() {
    if (!currentRequestId || !selectedImageId) return;

    const currentImgData = currentImages.find(i => i.id === selectedImageId);
    if (!currentImgData) return;

    // Use the global GAS_URL or ensure it matches
    // const GAS_URL = ...; // Removed duplicate local declaration

    // Overall request info label from UI
    const namePhone = document.getElementById('infoNamePhone').innerText.split(' / ');
    const name = namePhone[0];
    const phone = namePhone[1];

    showLoading("데이터 저장 중...");

    const payload = {
        type: "ADMIN_SAVE",
        id: selectedImageId, // Crucial: unique identity for the specific row
        name: name,
        phone: phone,
        location: currentImgData.location_type,
        width: document.getElementById('resWidth').value,
        height: document.getElementById('resHeight').value,
        status: document.getElementById('statusSelect').value,
        memo: document.getElementById('memoText').value
    };

    try {
        // 1. Update Google Sheets (Async)
        fetch(GAS_URL, {
            method: 'POST',
            mode: 'no-cors',
            body: JSON.stringify(payload)
        });

        // 2. Immediately update local memory for current session persistence
        const imgEntry = currentImages.find(i => i.id === selectedImageId);
        if (imgEntry) {
            imgEntry.width = payload.width;
            imgEntry.height = payload.height;
        }

        // Also update allRawData for consistency when re-selecting the group
        const rawEntry = allRawData.find(r => (findVal(r, ID_KEYS) || r.id) === selectedImageId);
        if (rawEntry) {
            rawEntry["가로 mm"] = payload.width;
            rawEntry["width"] = payload.width;
            rawEntry["세로 mm"] = payload.height;
            rawEntry["height"] = payload.height;
            rawEntry["status"] = payload.status;
            rawEntry["상태"] = payload.status;
            rawEntry["memo"] = payload.memo;
            rawEntry["메모"] = payload.memo;
        }

        // 3. Update local DB (FastAPI)
        const requestFormData = new FormData();
        requestFormData.append('memo', payload.memo);
        requestFormData.append('status', payload.status);
        fetch(`/api/update_request/${currentRequestId}`, { method: 'POST', body: requestFormData });

        const imageFormData = new FormData();
        imageFormData.append('width', payload.width);
        imageFormData.append('height', payload.height);

        try {
            await fetch(`/api/save_image_result/${selectedImageId}`, { method: 'POST', body: imageFormData });
        } catch (localErr) {
            console.warn("Local image update failed:", localErr);
        }

        hideLoading();
        alert("분석 결과가 저장되었습니다.");

        // Refresh after a short delay to give GAS time to settle
        setTimeout(loadRequests, 1500);

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

async function resetAnalysis() {
    if (!confirm("모든 측정 데이터와 분석 결과를 초기화하시겠습니까? (저장 전 상태로 되돌아갑니다)")) return;

    refBox = null;
    measureLine = null;
    ['w1', 'w2', 'w3', 'h1', 'h2', 'h3'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('resWidth').value = '0';
    document.getElementById('resHeight').value = '0';
    updateAverages();
    draw();
}

/**
 * Helper to draw all overlays (Info box, Dimensions, etc.) on any context (Canvas or Export)
 */
function drawOverlaysToCtx(targetCtx, w, h, isLive = false) {
    const namePhone = document.getElementById('infoNamePhone').innerText;
    const locRef = document.getElementById('infoLocationRef').innerText;
    const avgW = document.getElementById('resWidth').value;
    const avgH = document.getElementById('resHeight').value;

    if (!namePhone || namePhone === "-") return;

    targetCtx.save();

    // Scale factors for live vs export
    const scale = isLive ? (1 / currentScale) : (w / 1200); // Normalize scale based on reference width
    const fontSize = (isLive ? 16 : 30) * scale;

    targetCtx.shadowColor = "rgba(0,0,0,0.5)";
    targetCtx.shadowBlur = 5 * scale;

    // 1. Info Box (Top Left)
    const infoX = 20 * scale;
    const infoY = 40 * scale;
    targetCtx.font = `bold ${fontSize}px sans-serif`;

    const dimTextTop = `${parseFloat(avgW) > 0 ? '가로: ' + parseFloat(avgW).toLocaleString() + 'mm' : ''} ${parseFloat(avgH) > 0 ? '세로: ' + parseFloat(avgH).toLocaleString() + 'mm' : ''}`.trim();
    const lines = [namePhone, locRef];
    if (dimTextTop) lines.push(dimTextTop);

    const boxWidth = Math.max(...lines.map(l => targetCtx.measureText(l).width)) + (20 * scale);
    const boxHeight = fontSize * (lines.length * 1.35); // Precise height based on number of lines

    targetCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    targetCtx.fillRect(infoX - (8 * scale), infoY - fontSize * 1.1, boxWidth, boxHeight);

    targetCtx.fillStyle = 'white';
    targetCtx.fillText(namePhone, infoX, infoY);
    targetCtx.font = `${fontSize * 0.8}px sans-serif`;
    targetCtx.fillText(locRef, infoX, infoY + (fontSize * 1.2));

    if (dimTextTop) {
        targetCtx.fillStyle = '#60a5fa'; // Light blue for dimensions
        targetCtx.fillText(dimTextTop, infoX, infoY + (fontSize * 2.3));
    }

    // 2. Reference Box (If exists)
    if (refBox) {
        targetCtx.strokeStyle = '#22c55e';
        targetCtx.lineWidth = 3 * scale;
        targetCtx.strokeRect(refBox.x, refBox.y, refBox.w, refBox.h);
    }

    // 3. Measurement Results (Center)
    if (measureLine && (parseFloat(avgW) > 0 || parseFloat(avgH) > 0)) {
        // Draw the line too if exporting
        if (!isLive) {
            targetCtx.strokeStyle = '#ef4444';
            targetCtx.lineWidth = 5 * scale;
            targetCtx.beginPath();
            targetCtx.moveTo(measureLine.x1, measureLine.y1);
            targetCtx.lineTo(measureLine.x2, measureLine.y2);
            targetCtx.stroke();
        }

        const midX = (measureLine.x1 + measureLine.x2) / 2;
        const midY = (measureLine.y1 + measureLine.y2) / 2;

        const dimFontSize = fontSize * 1.5;
        targetCtx.font = `bold ${dimFontSize}px sans-serif`;
        const dimText = `${parseFloat(avgW) > 0 ? '가로: ' + parseFloat(avgW).toLocaleString() + 'mm' : ''} ${parseFloat(avgH) > 0 ? '세로: ' + parseFloat(avgH).toLocaleString() + 'mm' : ''}`;

        const txtWidth = targetCtx.measureText(dimText).width;
        targetCtx.fillStyle = 'rgba(239, 68, 68, 0.9)';
        targetCtx.fillRect(midX - (txtWidth / 2) - (15 * scale), midY - (dimFontSize / 2) - (5 * scale), txtWidth + (30 * scale), dimFontSize + (10 * scale));

        targetCtx.fillStyle = 'white';
        targetCtx.textAlign = 'center';
        targetCtx.fillText(dimText, midX, midY + (dimFontSize / 3));
        targetCtx.textAlign = 'start';
    }

    targetCtx.restore();
}

function downloadImage() {
    if (!currentImage) return;

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = currentImage.width;
    exportCanvas.height = currentImage.height;
    const eCtx = exportCanvas.getContext('2d');

    eCtx.drawImage(currentImage, 0, 0);
    drawOverlaysToCtx(eCtx, currentImage.width, currentImage.height, false);

    const link = document.createElement('a');
    const namePhone = document.getElementById('infoNamePhone').innerText;
    const safeName = namePhone.replace(/[/\\?%*:|"<>]/g, '_');
    link.download = `분석결과_${safeName}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
}

/**
 * Copy canvas image to clipboard
 */
async function copyImageToClipboard() {
    if (!currentImage) return;

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = currentImage.width;
    exportCanvas.height = currentImage.height;
    const eCtx = exportCanvas.getContext('2d');

    eCtx.drawImage(currentImage, 0, 0);
    drawOverlaysToCtx(eCtx, currentImage.width, currentImage.height, false);

    try {
        const blob = await new Promise(resolve => exportCanvas.toBlob(resolve, 'image/png'));
        const item = new ClipboardItem({ 'image/png': blob });
        await navigator.clipboard.write([item]);
        alert("분석 이미지가 클립보드에 복사되었습니다. (붙여넣기 가능)");
    } catch (err) {
        console.error("Clipboard Error:", err);
        alert("이미지 복사에 실패했습니다.");
    }
}

init();
