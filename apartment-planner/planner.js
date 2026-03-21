(function() {
'use strict';

// === Constants ===
const COLORS = ['#6366f1','#34d399','#fb923c','#f87171','#a78bfa','#38bdf8','#facc15','#f472b6'];
const GRID_INCHES = 6;
const SNAP_THRESHOLD_PX = 8;
const EDGE_SNAP_THRESHOLD_PX = 6;
const MAX_UNDO = 50;
const MAX_URL_BYTES = 1572864; // 1.5MB
const CONFIDENCE_THRESHOLD = 0.9;
const DEFAULT_OPACITY = 70;
const ZOOM_STEP = 0.1;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;

// === State ===
let state = {
    image: null,          // base64 JPEG
    imageEl: null,        // not serialized — runtime ref to <image> element
    scale: null,          // { pixelsPerFoot }
    walls: [],            // [{ x1, y1, x2, y2 }]
    doors: [],            // [{ x, y, width, angle, flip }]
    pieces: [],           // [{ id, type, x, y, width, height, radius, cutWidth, cutHeight, cutCorner, rotation, label, locked, color }]
    viewBox: { x: 0, y: 0, w: 800, h: 600 }
};

let phase = 'upload';     // 'upload' | 'detect' | 'editor'
let tool = 'select';
let selection = [];        // array of piece IDs
let colorIndex = 0;
let undoStack = [];
let redoStack = [];
let nextId = 1;
let imageOpacity = DEFAULT_OPACITY;

// Detection phase state
let detectStep = 'click-wall'; // 'click-wall' | 'select-room' | 'enter-dims' | 'review'
let wallSample = null;         // { r, g, b, thickness }
let roomCorners = [];          // [{ x, y }, { x, y }]
let candidateLabels = [];      // populated by runWallDetection
let detectMask = null;         // binary mask kept alive for add-wall re-extraction
let detectLabels = null;       // connected component labels matrix

// Interaction state
let drag = null;               // { pieceId, startX, startY, offsetX, offsetY }
let marquee = null;            // { startX, startY }
let pan = null;                // { startX, startY, startVBX, startVBY }
let isPanning = false;
let spaceHeld = false;

// === DOM refs (populated in init) ===
let $svg, $canvasWrap, $layerImage, $layerWalls, $layerDoors, $layerPieces, $layerGuides, $layerSelection;
let $detectCanvas, $detectSvg, $detectPanel, $detectInstructions;
let $propLabel, $propWidth, $propHeight, $propRadius, $propRotation, $propCutW, $propCutH, $propCutCorner;
let $piecesList, $zoomLevel, $imgOpacity, $imgOpacityVal, $scaleBar, $scaleBarLabel;

// === Initialization ===
function init() {
    cacheDom();
    bindUpload();
    bindToolbar();
    bindCanvas();
    bindPanel();
    bindKeyboard();
    bindZoom();
    bindDetectionToolbar();

    // Wire detection screen buttons
    document.getElementById('btn-confirm-detect').addEventListener('click', () => {
        showModal('Wall editing cannot be undone after this step. Continue?', () => {
            resetUndo();
            setPhase('editor');
            fitImageToView(state._imgWidth, state._imgHeight);
        });
    });

    document.getElementById('btn-skip-detect').addEventListener('click', () => {
        state.walls = [];
        initManualMode();
        fitImageToView(state._imgWidth, state._imgHeight);
    });

    document.getElementById('btn-retry-detect').addEventListener('click', () => {
        state.walls = [];
        wallSample = null;
        roomCorners = [];
        $detectSvg.innerHTML = '';
        document.getElementById('detect-confidence').classList.add('hidden');
        document.getElementById('btn-retry-detect').classList.add('hidden');
        detectStep = 'click-wall';
        updateDetectInstructions();
    });

    loadFromUrl() || loadFromStorage();
}

function cacheDom() {
    $svg = document.getElementById('main-svg');
    $canvasWrap = document.getElementById('canvas-wrap');
    $layerImage = document.getElementById('layer-image');
    $layerWalls = document.getElementById('layer-walls');
    $layerDoors = document.getElementById('layer-doors');
    $layerPieces = document.getElementById('layer-pieces');
    $layerGuides = document.getElementById('layer-guides');
    $layerSelection = document.getElementById('layer-selection');
    $detectCanvas = document.getElementById('detect-canvas');
    $detectSvg = document.getElementById('detect-svg');
    $detectPanel = document.getElementById('detect-panel');
    $detectInstructions = document.getElementById('detect-instructions');
    $propLabel = document.getElementById('prop-label');
    $propWidth = document.getElementById('prop-width');
    $propHeight = document.getElementById('prop-height');
    $propRadius = document.getElementById('prop-radius');
    $propRotation = document.getElementById('prop-rotation');
    $propCutW = document.getElementById('prop-cut-w');
    $propCutH = document.getElementById('prop-cut-h');
    $propCutCorner = document.getElementById('prop-cut-corner');
    $piecesList = document.getElementById('pieces-list');
    $zoomLevel = document.getElementById('zoom-level');
    $imgOpacity = document.getElementById('img-opacity');
    $imgOpacityVal = document.getElementById('img-opacity-val');
    $scaleBar = document.getElementById('scale-bar');
    $scaleBarLabel = document.getElementById('scale-bar-label');
}

// === Unit Helpers ===
function inchesToPx(inches) {
    return state.scale ? inches * state.scale.pixelsPerFoot / 12 : inches;
}

function pxToInches(px) {
    return state.scale ? px * 12 / state.scale.pixelsPerFoot : px;
}

function svgPoint(clientX, clientY) {
    // Convert screen coordinates to SVG viewBox coordinates
    const rect = $svg.getBoundingClientRect();
    const vb = state.viewBox;
    return {
        x: vb.x + (clientX - rect.left) / rect.width * vb.w,
        y: vb.y + (clientY - rect.top) / rect.height * vb.h
    };
}

// === ViewBox / Zoom ===
function applyViewBox() {
    const vb = state.viewBox;
    $svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    updateGrid();
    updateZoomDisplay();
    updateScaleBar();
}

function getZoomLevel() {
    // zoom = 1 when viewBox.w equals the container width
    return $canvasWrap.clientWidth / state.viewBox.w;
}

function zoomAt(cx, cy, delta) {
    const vb = state.viewBox;
    const factor = delta > 0 ? (1 - ZOOM_STEP) : (1 + ZOOM_STEP);
    const newW = vb.w * factor;
    const newH = vb.h * factor;
    const zoom = $canvasWrap.clientWidth / newW;
    if (zoom < MIN_ZOOM || zoom > MAX_ZOOM) return;
    // Keep point (cx, cy) stationary
    const ratioX = (cx - vb.x) / vb.w;
    const ratioY = (cy - vb.y) / vb.h;
    vb.x = cx - ratioX * newW;
    vb.y = cy - ratioY * newH;
    vb.w = newW;
    vb.h = newH;
    applyViewBox();
}

function fitImageToView(imgW, imgH) {
    const cw = $canvasWrap.clientWidth;
    const ch = $canvasWrap.clientHeight;
    const padding = 0.05;
    const scale = Math.min(cw / imgW, ch / imgH) * (1 - padding * 2);
    const w = cw / scale;
    const h = ch / scale;
    state.viewBox = {
        x: (imgW - w) / 2,
        y: (imgH - h) / 2,
        w: w,
        h: h
    };
    applyViewBox();
}

function updateZoomDisplay() {
    const pct = Math.round(getZoomLevel() * 100);
    $zoomLevel.textContent = pct + '%';
}

function updateScaleBar() {
    if (!state.scale) { $scaleBar.classList.add('hidden'); return; }
    $scaleBar.classList.remove('hidden');
    // Show a bar representing 5 feet at current zoom
    const fiveFeetPx = state.scale.pixelsPerFoot * 5 * getZoomLevel();
    document.getElementById('scale-bar-line').style.width = fiveFeetPx + 'px';
    $scaleBarLabel.textContent = '5 ft';
}

// === Grid ===
function updateGrid() {
    if (!state.scale) return;
    const gridPx = inchesToPx(GRID_INCHES);
    const pat = document.getElementById('grid-pattern');
    pat.setAttribute('width', gridPx);
    pat.setAttribute('height', gridPx);
    pat.setAttribute('x', state.viewBox.x);
    pat.setAttribute('y', state.viewBox.y);
    const dot = pat.querySelector('circle');
    const r = Math.max(0.5, gridPx * 0.02);
    dot.setAttribute('cx', gridPx / 2);
    dot.setAttribute('cy', gridPx / 2);
    dot.setAttribute('r', r);
}

// === Pan ===
function startPan(e) {
    isPanning = true;
    pan = {
        startX: e.clientX,
        startY: e.clientY,
        startVBX: state.viewBox.x,
        startVBY: state.viewBox.y
    };
    $svg.classList.add('panning');
}

function movePan(e) {
    if (!pan) return;
    const dx = (e.clientX - pan.startX) / getZoomLevel();
    const dy = (e.clientY - pan.startY) / getZoomLevel();
    state.viewBox.x = pan.startVBX - dx;
    state.viewBox.y = pan.startVBY - dy;
    applyViewBox();
}

function endPan() {
    pan = null;
    isPanning = false;
    $svg.classList.remove('panning');
}

// === Phase Transitions ===
function setPhase(newPhase) {
    phase = newPhase;
    document.body.className = 'phase-' + newPhase;
    if (newPhase === 'editor') {
        // Show scale tool only in manual mode
        const scaleTool = document.getElementById('tool-scale');
        if (state.walls.length === 0) scaleTool.classList.remove('hidden');
        else scaleTool.classList.add('hidden');
        applyViewBox();
        renderAll();
    }
}

// === Image Upload ===
function bindUpload() {
    const btnUpload = document.getElementById('btn-upload');
    const fileInput = document.getElementById('file-input');

    btnUpload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        loadImage(file);
    });
}

function loadImage(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            // Compress: cap at 1200px, JPEG quality 0.6
            const maxDim = 1200;
            let w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
                const ratio = maxDim / Math.max(w, h);
                w = Math.round(w * ratio);
                h = Math.round(h * ratio);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            state.image = canvas.toDataURL('image/jpeg', 0.6);
            state._imgWidth = w;
            state._imgHeight = h;

            setPhase('detect');
            initDetection(w, h);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

// === SVG Image Rendering ===
function renderImage() {
    $layerImage.innerHTML = '';
    if (!state.image) return;
    const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    img.setAttribute('href', state.image);
    img.setAttribute('width', state._imgWidth);
    img.setAttribute('height', state._imgHeight);
    img.setAttribute('opacity', imageOpacity / 100);
    img.setAttribute('pointer-events', 'none');
    state.imageEl = img;
    $layerImage.appendChild(img);
}

function renderAll() {
    renderImage();
    renderWalls();
    renderDoors();
    renderPieces();
    updatePiecesList();
}

// Stubs for later tasks
function renderWalls() {
    $layerWalls.innerHTML = '';
    state.walls.forEach(w => {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', w.x1); line.setAttribute('y1', w.y1);
        line.setAttribute('x2', w.x2); line.setAttribute('y2', w.y2);
        line.classList.add('wall-segment');
        $layerWalls.appendChild(line);
    });
}

// === Shape Rendering ===
function createShapeSVG(piece) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-id', piece.id);
    g.classList.add('piece-shape');
    if (piece.locked) g.classList.add('locked');
    if (selection.includes(piece.id)) g.classList.add('selected');

    const wpx = inchesToPx(piece.width || 0);
    const hpx = inchesToPx(piece.height || 0);
    const rpx = inchesToPx(piece.radius || 0);

    // Apply rotation transform around piece center
    let cx, cy;
    if (piece.type === 'circle') {
        cx = piece.x; cy = piece.y;
    } else {
        cx = piece.x + wpx / 2;
        cy = piece.y + hpx / 2;
    }
    g.setAttribute('transform', `rotate(${piece.rotation} ${cx} ${cy})`);

    let shape;
    switch (piece.type) {
        case 'rect':
            shape = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            shape.setAttribute('x', piece.x);
            shape.setAttribute('y', piece.y);
            shape.setAttribute('width', wpx);
            shape.setAttribute('height', hpx);
            shape.setAttribute('rx', 2);
            shape.setAttribute('fill', piece.color + '22');
            shape.setAttribute('stroke', piece.color);
            shape.setAttribute('stroke-width', 2);
            g.appendChild(shape);
            break;

        case 'circle':
            shape = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            shape.setAttribute('cx', piece.x);
            shape.setAttribute('cy', piece.y);
            shape.setAttribute('r', rpx);
            shape.setAttribute('fill', piece.color + '22');
            shape.setAttribute('stroke', piece.color);
            shape.setAttribute('stroke-width', 2);
            g.appendChild(shape);
            break;

        case 'lshape':
            shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            shape.setAttribute('d', lshapePath(piece));
            shape.setAttribute('fill', piece.color + '22');
            shape.setAttribute('stroke', piece.color);
            shape.setAttribute('stroke-width', 2);
            g.appendChild(shape);
            break;
    }

    // Label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.classList.add('piece-label');
    text.setAttribute('x', cx);
    text.setAttribute('y', cy);
    text.textContent = piece.label || '';
    g.appendChild(text);

    return g;
}

function lshapePath(piece) {
    const w = inchesToPx(piece.width);
    const h = inchesToPx(piece.height);
    const cw = inchesToPx(piece.cutWidth);
    const ch = inchesToPx(piece.cutHeight);
    const x = piece.x, y = piece.y;
    const corner = piece.cutCorner || 'tr';

    // Draw L-shape as a polygon with the cut corner removed
    switch (corner) {
        case 'tr': return `M${x},${y} L${x+w-cw},${y} L${x+w-cw},${y+ch} L${x+w},${y+ch} L${x+w},${y+h} L${x},${y+h} Z`;
        case 'tl': return `M${x+cw},${y} L${x+w},${y} L${x+w},${y+h} L${x},${y+h} L${x},${y+ch} L${x+cw},${y+ch} Z`;
        case 'br': return `M${x},${y} L${x+w},${y} L${x+w},${y+h-ch} L${x+w-cw},${y+h-ch} L${x+w-cw},${y+h} L${x},${y+h} Z`;
        case 'bl': return `M${x},${y} L${x+w},${y} L${x+w},${y+h} L${x+cw},${y+h} L${x+cw},${y+h-ch} L${x},${y+h-ch} Z`;
    }
}

function renderPieces() {
    $layerPieces.innerHTML = '';
    state.pieces.forEach(p => {
        const el = createShapeSVG(p);
        $layerPieces.appendChild(el);
    });
}

function nextColor() {
    const c = COLORS[colorIndex % COLORS.length];
    colorIndex++;
    return c;
}

function addPiece(type, x, y) {
    const defaults = {
        rect: { width: 60, height: 36 },
        circle: { radius: 18 },
        lshape: { width: 84, height: 60, cutWidth: 36, cutHeight: 24, cutCorner: 'tr' }
    };
    const d = defaults[type] || defaults.rect;
    const piece = {
        id: 'p' + (nextId++),
        type: type,
        x: x,
        y: y,
        rotation: 0,
        label: '',
        locked: false,
        color: nextColor(),
        ...d
    };
    pushUndo();
    state.pieces.push(piece);
    renderPieces();
    selectPiece(piece.id);
    saveState();
    return piece;
}

// === Wall Detection ===
let cvReady = false;

function loadOpenCV() {
    return new Promise((resolve, reject) => {
        if (cvReady) { resolve(); return; }
        const script = document.createElement('script');
        script.src = 'https://docs.opencv.org/4.9.0/opencv.js';
        script.async = true;
        script.onload = () => {
            // OpenCV.js sets cv as a factory function
            if (typeof cv === 'function') {
                cv = cv();
                cv.onRuntimeInitialized = () => { cvReady = true; resolve(); };
            } else if (cv.Mat) {
                cvReady = true; resolve();
            }
        };
        script.onerror = () => reject(new Error('Failed to load OpenCV.js'));
        document.head.appendChild(script);
    });
}

function initDetection(imgW, imgH) {
    // Draw image on the hidden canvas for pixel access
    const canvas = $detectCanvas;
    canvas.width = imgW;
    canvas.height = imgH;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
        ctx.drawImage(img, 0, 0, imgW, imgH);
        detectStep = 'click-wall';
        updateDetectInstructions();
    };
    img.src = state.image;

    // Bind detection canvas clicks (remove first to prevent double-binding on re-upload)
    canvas.removeEventListener('click', onDetectCanvasClick);
    canvas.addEventListener('click', onDetectCanvasClick);
}

function onDetectCanvasClick(e) {
    const canvas = $detectCanvas;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);

    if (detectStep === 'click-wall') {
        sampleWallAt(x, y);
    } else if (detectStep === 'select-room') {
        addRoomCorner(x, y);
    }
}

function sampleWallAt(x, y) {
    const ctx = $detectCanvas.getContext('2d');
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    const r = pixel[0], g = pixel[1], b = pixel[2];

    // Measure thickness by scanning perpendicular (horizontal scan)
    let thickness = 1;
    const tolerance = 40;
    for (let dx = 1; dx < 50; dx++) {
        const p = ctx.getImageData(x + dx, y, 1, 1).data;
        if (Math.abs(p[0] - r) + Math.abs(p[1] - g) + Math.abs(p[2] - b) < tolerance) {
            thickness++;
        } else break;
    }
    for (let dx = -1; dx > -50; dx--) {
        const p = ctx.getImageData(x + dx, y, 1, 1).data;
        if (Math.abs(p[0] - r) + Math.abs(p[1] - g) + Math.abs(p[2] - b) < tolerance) {
            thickness++;
        } else break;
    }

    wallSample = { r, g, b, thickness, x, y };
    detectStep = 'select-room';
    updateDetectInstructions();
}

function addRoomCorner(x, y) {
    roomCorners.push({ x, y });
    // Draw corner marker on detect SVG
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x); circle.setAttribute('cy', y);
    circle.setAttribute('r', 5);
    circle.setAttribute('fill', '#fb923c');
    $detectSvg.appendChild(circle);

    if (roomCorners.length === 2) {
        detectStep = 'enter-dims';
        showRoomModal();
    }
}

function showRoomModal() {
    document.getElementById('room-modal').classList.remove('hidden');
    document.getElementById('btn-set-room').addEventListener('click', () => {
        const widthFt = parseFloat(document.getElementById('room-width').value) || 0;
        const heightFt = parseFloat(document.getElementById('room-height').value) || 0;
        if (widthFt <= 0 || heightFt <= 0) return;

        const c = roomCorners;
        const pxW = Math.abs(c[1].x - c[0].x);
        const pxH = Math.abs(c[1].y - c[0].y);
        const pxAspect = pxW / pxH;
        const realAspect = widthFt / heightFt;

        // Check aspect ratio match (within 15% tolerance)
        const aspectCheck = document.getElementById('room-aspect-check');
        const ratio = Math.abs(pxAspect - realAspect) / realAspect;
        if (ratio > 0.15) {
            aspectCheck.className = 'warn';
            aspectCheck.textContent = `Aspect ratio mismatch (${(pxAspect).toFixed(2)} vs ${realAspect.toFixed(2)}). Dimensions may not match the selected area.`;
            aspectCheck.classList.remove('hidden');
        } else {
            aspectCheck.className = 'pass';
            aspectCheck.textContent = `Aspect ratio matches (${realAspect.toFixed(2)})`;
            aspectCheck.classList.remove('hidden');
        }

        // Average both axis scales
        const scaleX = pxW / widthFt;
        const scaleY = pxH / heightFt;
        state.scale = { pixelsPerFoot: (scaleX + scaleY) / 2 };

        document.getElementById('room-modal').classList.add('hidden');
        runWallDetection();
    }, { once: true });
}

async function runWallDetection() {
    updateDetectInstructions('Detecting walls...');

    try {
        await loadOpenCV();
    } catch (e) {
        updateDetectInstructions('Failed to load OpenCV. Falling back to manual mode.');
        document.getElementById('btn-skip-detect').classList.remove('hidden');
        return;
    }

    const canvas = $detectCanvas;
    const src = cv.imread(canvas);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Threshold based on sampled wall color
    const { r, g, b, thickness } = wallSample;
    const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const tolerance = 40;
    const low = new cv.Mat(gray.rows, gray.cols, cv.CV_8UC1, new cv.Scalar(Math.max(0, lum - tolerance)));
    const high = new cv.Mat(gray.rows, gray.cols, cv.CV_8UC1, new cv.Scalar(Math.min(255, lum + tolerance)));

    const mask = new cv.Mat();
    cv.inRange(gray, low, high, mask);

    // Morphological close to connect nearby pixels
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);

    // Connected components
    const labels = new cv.Mat();
    const stats = new cv.Mat();
    const centroids = new cv.Mat();
    const nLabels = cv.connectedComponentsWithStats(mask, labels, stats, centroids);

    // Find component at user's click point
    const clickLabel = labels.intAt(wallSample.y, wallSample.x);
    if (clickLabel === 0) {
        // Click was on background — detection failed
        showDetectionFailed();
        src.delete(); gray.delete(); low.delete(); high.delete(); mask.delete();
        labels.delete(); stats.delete(); centroids.delete(); kernel.delete();
        return;
    }

    // Isolate the clicked component
    const componentMask = new cv.Mat();
    cv.compare(labels, new cv.Mat(labels.rows, labels.cols, labels.type(), new cv.Scalar(clickLabel)), componentMask, cv.CMP_EQ);

    // Find contours
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(componentMask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    // Approximate contours to line segments
    const walls = [];
    for (let i = 0; i < contours.size(); i++) {
        const approx = new cv.Mat();
        const peri = cv.arcLength(contours.get(i), true);
        cv.approxPolyDP(contours.get(i), approx, 0.01 * peri, true);

        for (let j = 0; j < approx.rows; j++) {
            const next = (j + 1) % approx.rows;
            walls.push({
                x1: approx.intAt(j, 0), y1: approx.intAt(j, 1),
                x2: approx.intAt(next, 0), y2: approx.intAt(next, 1)
            });
        }
        approx.delete();
    }

    // Compute confidence
    const totalWallPixels = cv.countNonZero(mask);
    const componentPixels = cv.countNonZero(componentMask);
    const connectedness = totalWallPixels > 0 ? componentPixels / totalWallPixels : 0;

    const structuralCount = walls.filter(w => {
        const angle = Math.atan2(Math.abs(w.y2 - w.y1), Math.abs(w.x2 - w.x1)) * 180 / Math.PI;
        return angle < 10 || angle > 80;
    }).length;
    const structure = walls.length > 0 ? structuralCount / walls.length : 0;

    const totalPerimeter = walls.reduce((s, w) => s + Math.sqrt((w.x2 - w.x1) ** 2 + (w.y2 - w.y1) ** 2), 0);
    const imgPerimeter = 2 * (canvas.width + canvas.height);
    const coverageRatio = totalPerimeter / imgPerimeter;
    const coverage = (coverageRatio >= 0.5 && coverageRatio <= 5) ? 1 : 0;

    const connScore = connectedness >= 0.6 ? 1 : connectedness >= 0.3 ? (connectedness - 0.3) / 0.3 : 0;
    const structScore = structure >= 0.7 ? 1 : structure >= 0.4 ? (structure - 0.4) / 0.3 : 0;
    const confidence = connScore * 0.4 + structScore * 0.35 + coverage * 0.25;

    // Collect candidate disconnected segments
    const candidates = [];
    for (let lbl = 1; lbl < nLabels; lbl++) {
        if (lbl === clickLabel) continue;
        const area = stats.intAt(lbl, cv.CC_STAT_AREA);
        if (area < thickness * 10) continue; // Too small to be a wall
        candidates.push(lbl);
    }

    // Clean up OpenCV mats (keep labels and mask alive for add-wall)
    src.delete(); gray.delete(); low.delete(); high.delete();
    componentMask.delete(); contours.delete(); hierarchy.delete(); kernel.delete();

    // Apply results
    if (confidence >= CONFIDENCE_THRESHOLD) {
        state.walls = walls;
        candidateLabels = candidates;
        detectLabels = labels;   // keep alive for onDetectAddClick
        detectMask = mask;       // keep alive for candidate rendering
        // stats and centroids can be cleaned up
        stats.delete(); centroids.delete();
        showDetectionResults(confidence, candidates);
        renderCandidateWalls();
    } else {
        // Clean up everything on failure
        labels.delete(); stats.delete(); centroids.delete(); mask.delete();
        showDetectionFailed(confidence);
    }
}

function showDetectionResults(confidence, candidates) {
    detectStep = 'review';
    const pct = Math.round(confidence * 100);
    const confEl = document.getElementById('detect-confidence');
    confEl.classList.remove('hidden');
    confEl.className = 'pass';
    document.getElementById('confidence-value').textContent = pct + '% confidence';

    renderDetectedWalls();
    updateDetectInstructions('Walls detected. Review and edit, then confirm.');
    document.getElementById('btn-confirm-detect').classList.remove('hidden');
}

function showDetectionFailed(confidence) {
    const pct = confidence ? Math.round(confidence * 100) : 0;
    const confEl = document.getElementById('detect-confidence');
    confEl.classList.remove('hidden');
    confEl.className = 'fail';
    document.getElementById('confidence-value').textContent = (pct || '< 30') + '% confidence — detection failed';

    updateDetectInstructions('Wall detection didn\'t produce reliable results. Try clicking a different wall, or use manual mode. For better detection, upload a higher-contrast floor plan.');
    document.getElementById('btn-retry-detect').classList.remove('hidden');
    document.getElementById('btn-skip-detect').classList.remove('hidden');
}

function renderDetectedWalls() {
    $detectSvg.innerHTML = '';
    state.walls.forEach(w => {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', w.x1); line.setAttribute('y1', w.y1);
        line.setAttribute('x2', w.x2); line.setAttribute('y2', w.y2);
        line.classList.add('detected-wall');
        $detectSvg.appendChild(line);
    });
}

function updateDetectInstructions(text) {
    const msgs = {
        'click-wall': '<strong>Step 1:</strong> Click on any wall line in your floor plan. We\'ll sample its color and thickness.',
        'select-room': '<strong>Step 2:</strong> Click two opposite corners of a rectangular room you know the dimensions of.',
        'enter-dims': '<strong>Step 3:</strong> Enter the room dimensions to set scale.'
    };
    $detectInstructions.innerHTML = text || msgs[detectStep] || '';
}

function showModal(text, onConfirm) {
    document.getElementById('modal-text').textContent = text;
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('modal-confirm').addEventListener('click', () => {
        document.getElementById('modal-overlay').classList.add('hidden');
        onConfirm();
    }, { once: true });
    document.getElementById('modal-cancel').addEventListener('click', () => {
        document.getElementById('modal-overlay').classList.add('hidden');
    }, { once: true });
}

// === Detection Editor ===
let detectTool = 'select';
let eraserPath = [];
const ERASER_RADIUS = 10;

function bindDetectionToolbar() {
    document.querySelectorAll('#detect-toolbar .tool-btn[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#detect-toolbar .tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Set detection tool mode
            detectTool = btn.dataset.tool;
        });
    });
    document.getElementById('detect-undo').addEventListener('click', undo);
    document.getElementById('detect-redo').addEventListener('click', redo);

    // Wire detect SVG event listeners
    $detectSvg.addEventListener('mousedown', onDetectSvgMouseDown);
    $detectSvg.addEventListener('mousemove', onDetectSvgMouseMove);
    $detectSvg.addEventListener('mouseup', onDetectSvgMouseUp);
    $detectSvg.addEventListener('mouseleave', onDetectSvgMouseUp);
    $detectSvg.addEventListener('click', (e) => {
        const pt = detectSvgPoint(e);
        if (detectTool === 'add') {
            onDetectAddClick(pt.x, pt.y);
        } else if (detectTool === 'door') {
            onDetectDoorClick(pt.x, pt.y);
        }
    });
}

function onDetectSvgMouseDown(e) {
    if (detectTool === 'eraser') {
        pushUndo();
        eraserPath = [];
        const pt = detectSvgPoint(e);
        eraserPath.push(pt);
        renderEraserCursor(pt);
    }
    if (detectTool === 'select') {
        // Start marquee for wall segment selection
    }
}

function onDetectSvgMouseMove(e) {
    if (detectTool === 'eraser' && eraserPath.length > 0) {
        const pt = detectSvgPoint(e);
        eraserPath.push(pt);
        // Remove walls that intersect the eraser circle
        state.walls = state.walls.filter(w => {
            return !lineNearPoint(w.x1, w.y1, w.x2, w.y2, pt.x, pt.y, ERASER_RADIUS);
        });
        renderDetectedWalls();
        renderEraserCursor(pt);
    }
}

function onDetectSvgMouseUp() {
    eraserPath = [];
    removeEraserCursor();
}

function lineNearPoint(x1, y1, x2, y2, px, py, radius) {
    // Distance from point to line segment
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2) <= radius;
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const projX = x1 + t * dx, projY = y1 + t * dy;
    return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2) <= radius;
}

function renderEraserCursor(pt) {
    removeEraserCursor();
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.classList.add('eraser-cursor');
    circle.id = 'eraser-cursor';
    circle.setAttribute('cx', pt.x); circle.setAttribute('cy', pt.y);
    circle.setAttribute('r', ERASER_RADIUS);
    $detectSvg.appendChild(circle);
}

function removeEraserCursor() {
    const el = document.getElementById('eraser-cursor');
    if (el) el.remove();
}

function detectSvgPoint(e) {
    const rect = $detectSvg.getBoundingClientRect();
    const scaleX = $detectCanvas.width / rect.width;
    const scaleY = $detectCanvas.height / rect.height;
    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
    };
}

function onDetectAddClick(x, y) {
    if (!detectLabels) return;
    const clickedLabel = detectLabels.intAt(Math.round(y), Math.round(x));
    if (clickedLabel === 0) return; // background
    // Check if this label is already included
    if (!candidateLabels.includes(clickedLabel)) return;

    pushUndo();

    // Extract contours for this component
    const componentMask = new cv.Mat();
    cv.compare(detectLabels, new cv.Mat(detectLabels.rows, detectLabels.cols, detectLabels.type(), new cv.Scalar(clickedLabel)), componentMask, cv.CMP_EQ);
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(componentMask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < contours.size(); i++) {
        const approx = new cv.Mat();
        const peri = cv.arcLength(contours.get(i), true);
        cv.approxPolyDP(contours.get(i), approx, 0.01 * peri, true);
        for (let j = 0; j < approx.rows; j++) {
            const next = (j + 1) % approx.rows;
            state.walls.push({
                x1: approx.intAt(j, 0), y1: approx.intAt(j, 1),
                x2: approx.intAt(next, 0), y2: approx.intAt(next, 1)
            });
        }
        approx.delete();
    }

    // Remove from candidates so it can't be added twice
    candidateLabels = candidateLabels.filter(l => l !== clickedLabel);
    componentMask.delete(); contours.delete(); hierarchy.delete();

    renderDetectedWalls();
    renderCandidateWalls();
    saveState();
}

function renderCandidateWalls() {
    // Render remaining candidate components as dashed orange lines
    // (clickable, using .candidate-wall CSS class)
    if (!detectLabels || !detectMask) return;
    candidateLabels.forEach(lbl => {
        const compMask = new cv.Mat();
        cv.compare(detectLabels, new cv.Mat(detectLabels.rows, detectLabels.cols, detectLabels.type(), new cv.Scalar(lbl)), compMask, cv.CMP_EQ);
        const contours = new cv.MatVector();
        const hier = new cv.Mat();
        cv.findContours(compMask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        for (let i = 0; i < contours.size(); i++) {
            const approx = new cv.Mat();
            cv.approxPolyDP(contours.get(i), approx, 0.02 * cv.arcLength(contours.get(i), true), true);
            for (let j = 0; j < approx.rows; j++) {
                const next = (j + 1) % approx.rows;
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                line.setAttribute('x1', approx.intAt(j, 0)); line.setAttribute('y1', approx.intAt(j, 1));
                line.setAttribute('x2', approx.intAt(next, 0)); line.setAttribute('y2', approx.intAt(next, 1));
                line.classList.add('candidate-wall');
                line.addEventListener('click', () => onDetectAddClick(approx.intAt(j, 0), approx.intAt(j, 1)));
                $detectSvg.appendChild(line);
            }
            approx.delete();
        }
        compMask.delete(); contours.delete(); hier.delete();
    });
}

function onDetectDoorClick(x, y) {
    pushUndo();
    // Add a door at the clicked position
    state.doors.push({
        x: x, y: y,
        width: 30,
        angle: 0,
        flip: false
    });
    renderDetectedWalls(); // Re-render to show door arc too
    // Draw door arc on detect SVG
    const rpx = state.scale ? inchesToPx(30) : 30;
    const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arc.setAttribute('d', `M${x + rpx},${y} A${rpx},${rpx} 0 0,1 ${x},${y + rpx} L${x},${y} Z`);
    arc.classList.add('door-arc');
    $detectSvg.appendChild(arc);
    saveState();
}

// === Selection ===
function selectPiece(id) {
    selection = [id];
    renderPieces();
    showProperties(getPiece(id));
}

function addToSelection(id) {
    if (!selection.includes(id)) selection.push(id);
    renderPieces();
    if (selection.length === 1) showProperties(getPiece(selection[0]));
    else hideProperties();
}

function removeFromSelection(id) {
    selection = selection.filter(s => s !== id);
    renderPieces();
    if (selection.length === 1) showProperties(getPiece(selection[0]));
    else if (selection.length === 0) hideProperties();
}

function clearSelection() {
    selection = [];
    renderPieces();
    hideProperties();
}

function getPiece(id) {
    return state.pieces.find(p => p.id === id);
}

function showProperties(piece) {
    if (!piece) return;
    document.getElementById('props-section').classList.remove('hidden');
    $propLabel.value = piece.label || '';
    $propRotation.value = piece.rotation;

    // Show/hide type-specific fields
    const isRect = piece.type === 'rect';
    const isCircle = piece.type === 'circle';
    const isLshape = piece.type === 'lshape';

    document.getElementById('prop-radius-row').hidden = !isCircle;
    document.getElementById('prop-lshape-row').hidden = !isLshape;
    document.getElementById('prop-cut-corner-row').hidden = !isLshape;

    if (isCircle) {
        $propRadius.value = piece.radius;
        $propWidth.parentElement.parentElement.hidden = true;
    } else {
        $propWidth.value = piece.width;
        $propHeight.value = piece.height;
        $propWidth.parentElement.parentElement.hidden = false;
        if (isLshape) {
            $propCutW.value = piece.cutWidth;
            $propCutH.value = piece.cutHeight;
            $propCutCorner.value = piece.cutCorner;
        }
    }

    // Update lock button text
    document.getElementById('btn-lock').textContent = piece.locked ? 'Unlock' : 'Lock';
}

function hideProperties() {
    document.getElementById('props-section').classList.add('hidden');
}

// === Canvas Interactions ===
function bindCanvas() {
    $svg.addEventListener('mousedown', onCanvasMouseDown);
    $svg.addEventListener('mousemove', onCanvasMouseMove);
    $svg.addEventListener('mouseup', onCanvasMouseUp);
    $svg.addEventListener('mouseleave', onCanvasMouseUp);
    // Middle click pan
    $svg.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); startPan(e); }
    });
}

function onCanvasMouseDown(e) {
    if (e.button === 1) return; // middle click handled separately
    if (isPanning || spaceHeld) { startPan(e); return; }

    const pt = svgPoint(e.clientX, e.clientY);

    if (tool === 'select') {
        const hit = hitTestPiece(pt.x, pt.y);
        if (hit) {
            if (hit.locked) return;
            if (e.ctrlKey) {
                // Toggle multi-select
                if (selection.includes(hit.id)) removeFromSelection(hit.id);
                else addToSelection(hit.id);
            } else if (!selection.includes(hit.id)) {
                selectPiece(hit.id);
            }
            // Start drag — push undo BEFORE moving anything
            pushUndo();
            drag = {
                ids: [...selection],
                startX: pt.x,
                startY: pt.y,
                origPositions: selection.map(id => {
                    const p = getPiece(id);
                    return { id, x: p.x, y: p.y };
                }),
                hasMoved: false
            };
        } else {
            // Start marquee select
            if (!e.ctrlKey) clearSelection();
            marquee = { startX: pt.x, startY: pt.y };
        }
    } else if (['rect', 'circle', 'lshape'].includes(tool)) {
        addPiece(tool, pt.x, pt.y);
        tool = 'select';
        setActiveTool('select');
    } else if (tool === 'door') {
        addDoor(pt.x, pt.y);
        tool = 'select';
        setActiveTool('select');
    } else if (tool === 'scale') {
        handleScaleClick(pt);
    }
}

function onCanvasMouseMove(e) {
    const pt = svgPoint(e.clientX, e.clientY);

    if (pan) { movePan(e); return; }

    if (drag) {
        drag.hasMoved = true;
        let dx = pt.x - drag.startX;
        let dy = pt.y - drag.startY;

        // Snap (unless shift held)
        if (!e.shiftKey) {
            const snapped = applySnap(drag, dx, dy);
            dx = snapped.dx;
            dy = snapped.dy;
        }

        drag.origPositions.forEach(op => {
            const piece = getPiece(op.id);
            const newX = op.x + dx;
            const newY = op.y + dy;
            // Collision check before applying
            if (!wouldCollide(piece, newX, newY)) {
                piece.x = newX;
                piece.y = newY;
            }
        });
        renderPieces();
        renderSnapGuides(drag, dx, dy, e.shiftKey);
    }

    if (marquee) {
        renderMarquee(marquee.startX, marquee.startY, pt.x, pt.y);
    }

    // Scale line preview: update endpoint while placing second click
    if (tool === 'scale' && scaleLine) {
        scaleLine.x2 = pt.x;
        scaleLine.y2 = pt.y;
        renderScaleLine();
    }
}

function onCanvasMouseUp(e) {
    if (pan) { endPan(); return; }

    if (drag) {
        if (drag.hasMoved) {
            saveState();
            clearSnapGuides();
        } else {
            // No move occurred — pop the spurious undo entry
            undoStack.pop();
            updateUndoButtons();
        }
    }
    drag = null;

    if (marquee) {
        const pt = svgPoint(e.clientX, e.clientY);
        selectInMarquee(marquee.startX, marquee.startY, pt.x, pt.y);
        clearMarquee();
        marquee = null;
    }
}

function hitTestPiece(x, y) {
    // Iterate pieces in reverse (top-most first)
    for (let i = state.pieces.length - 1; i >= 0; i--) {
        const p = state.pieces[i];
        if (pointInPiece(x, y, p)) return p;
    }
    return null;
}

function pointInPiece(x, y, piece) {
    // Transform point into piece's local coordinate system (undo rotation)
    const wpx = inchesToPx(piece.width || 0);
    const hpx = inchesToPx(piece.height || 0);
    const rpx = inchesToPx(piece.radius || 0);
    let cx, cy;
    if (piece.type === 'circle') { cx = piece.x; cy = piece.y; }
    else { cx = piece.x + wpx / 2; cy = piece.y + hpx / 2; }

    const rad = -piece.rotation * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const lx = cos * (x - cx) - sin * (y - cy) + cx;
    const ly = sin * (x - cx) + cos * (y - cy) + cy;

    if (piece.type === 'circle') {
        return (lx - piece.x) ** 2 + (ly - piece.y) ** 2 <= rpx ** 2;
    }
    // Rect or L-shape bounding box (L-shape uses bounding box for hit test simplicity)
    return lx >= piece.x && lx <= piece.x + wpx && ly >= piece.y && ly <= piece.y + hpx;
}

// === Marquee ===
function renderMarquee(x1, y1, x2, y2) {
    $layerSelection.innerHTML = '';
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.classList.add('marquee');
    rect.setAttribute('x', Math.min(x1, x2));
    rect.setAttribute('y', Math.min(y1, y2));
    rect.setAttribute('width', Math.abs(x2 - x1));
    rect.setAttribute('height', Math.abs(y2 - y1));
    $layerSelection.appendChild(rect);
}

function clearMarquee() {
    $layerSelection.innerHTML = '';
}

function selectInMarquee(x1, y1, x2, y2) {
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    state.pieces.forEach(p => {
        const wpx = inchesToPx(p.width || p.radius * 2 || 0);
        const hpx = inchesToPx(p.height || p.radius * 2 || 0);
        const px = p.type === 'circle' ? p.x - inchesToPx(p.radius) : p.x;
        const py = p.type === 'circle' ? p.y - inchesToPx(p.radius) : p.y;
        // Piece intersects marquee
        if (px + wpx >= minX && px <= maxX && py + hpx >= minY && py <= maxY) {
            addToSelection(p.id);
        }
    });
}

function setActiveTool(name) {
    document.querySelectorAll('#toolbar .tool-btn[data-tool]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tool === name);
    });
    $svg.className = name === 'select' ? 'tool-select' : '';
}

// === Toolbar ===
function bindToolbar() {
    document.querySelectorAll('#toolbar .tool-btn[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => {
            tool = btn.dataset.tool;
            setActiveTool(tool);
        });
    });

    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);
}

// === Doors ===
function addDoor(x, y) {
    pushUndo();
    state.doors.push({
        x: x, y: y,
        width: 30, // 30 inches default (standard 2.5ft door)
        angle: 0,
        flip: false
    });
    renderDoors();
    saveState();
}

function renderDoors() {
    $layerDoors.innerHTML = '';
    state.doors.forEach((door, i) => {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('data-door-idx', i);
        const rpx = inchesToPx(door.width);
        const rad = door.angle * Math.PI / 180;
        const sweep = door.flip ? 0 : 1;

        // Door panel line (from hinge along the wall)
        const panelEndX = door.x + rpx * Math.cos(rad);
        const panelEndY = door.y + rpx * Math.sin(rad);
        const panel = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        panel.setAttribute('x1', door.x); panel.setAttribute('y1', door.y);
        panel.setAttribute('x2', panelEndX); panel.setAttribute('y2', panelEndY);
        panel.classList.add('door-panel');
        g.appendChild(panel);

        // 90-degree arc (quarter circle)
        const arcAngle = door.flip ? -Math.PI / 2 : Math.PI / 2;
        const endRad = rad + arcAngle;
        const arcEndX = door.x + rpx * Math.cos(endRad);
        const arcEndY = door.y + rpx * Math.sin(endRad);
        const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const largeArc = 0;
        arc.setAttribute('d', `M${panelEndX},${panelEndY} A${rpx},${rpx} 0 ${largeArc},${sweep} ${arcEndX},${arcEndY} L${door.x},${door.y} Z`);
        arc.classList.add('door-arc');
        arc.addEventListener('dblclick', () => {
            pushUndo();
            door.flip = !door.flip;
            renderDoors();
            saveState();
        });
        g.appendChild(arc);

        $layerDoors.appendChild(g);
    });
}

// === Collision Detection ===
function getPieceBounds(piece, overrideX, overrideY) {
    const x = overrideX !== undefined ? overrideX : piece.x;
    const y = overrideY !== undefined ? overrideY : piece.y;
    const wpx = inchesToPx(piece.width || piece.radius * 2 || 0);
    const hpx = inchesToPx(piece.height || piece.radius * 2 || 0);

    if (piece.type === 'circle') {
        const rpx = inchesToPx(piece.radius);
        return { x: x - rpx, y: y - rpx, w: rpx * 2, h: rpx * 2 };
    }
    return { x, y, w: wpx, h: hpx };
}

function aabbOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function getCorners(piece, overrideX, overrideY) {
    const x = overrideX !== undefined ? overrideX : piece.x;
    const y = overrideY !== undefined ? overrideY : piece.y;
    const wpx = inchesToPx(piece.width || 0);
    const hpx = inchesToPx(piece.height || 0);

    if (piece.type === 'circle') {
        // Approximate circle as a many-sided polygon for SAT
        const rpx = inchesToPx(piece.radius);
        const pts = [];
        for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            pts.push({ x: x + rpx * Math.cos(a), y: y + rpx * Math.sin(a) });
        }
        return pts;
    }

    // Rectangle corners
    const corners = [
        { x: x, y: y },
        { x: x + wpx, y: y },
        { x: x + wpx, y: y + hpx },
        { x: x, y: y + hpx }
    ];

    // Rotate around center
    if (piece.rotation !== 0) {
        const cx = x + wpx / 2, cy = y + hpx / 2;
        const rad = piece.rotation * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        return corners.map(c => ({
            x: cos * (c.x - cx) - sin * (c.y - cy) + cx,
            y: sin * (c.x - cx) + cos * (c.y - cy) + cy
        }));
    }
    return corners;
}

function satOverlap(cornersA, cornersB) {
    const axes = getAxes(cornersA).concat(getAxes(cornersB));
    for (const axis of axes) {
        const projA = project(cornersA, axis);
        const projB = project(cornersB, axis);
        if (projA.max < projB.min || projB.max < projA.min) return false;
    }
    return true;
}

function getAxes(corners) {
    const axes = [];
    for (let i = 0; i < corners.length; i++) {
        const next = corners[(i + 1) % corners.length];
        const edge = { x: next.x - corners[i].x, y: next.y - corners[i].y };
        // Normal (perpendicular)
        const len = Math.sqrt(edge.x * edge.x + edge.y * edge.y);
        if (len === 0) continue;
        axes.push({ x: -edge.y / len, y: edge.x / len });
    }
    return axes;
}

function project(corners, axis) {
    let min = Infinity, max = -Infinity;
    for (const c of corners) {
        const dot = c.x * axis.x + c.y * axis.y;
        if (dot < min) min = dot;
        if (dot > max) max = dot;
    }
    return { min, max };
}

function wouldCollide(piece, newX, newY) {
    const testCorners = getCorners(piece, newX, newY);
    const testBounds = getPieceBounds(piece, newX, newY);

    // Check against other pieces
    for (const other of state.pieces) {
        if (other.id === piece.id) continue;
        if (selection.includes(other.id)) continue; // moving together
        const otherBounds = getPieceBounds(other);
        if (!aabbOverlap(testBounds, otherBounds)) continue;
        const otherCorners = getCorners(other);
        if (satOverlap(testCorners, otherCorners)) return true;
    }

    // Check against walls (thick line segments)
    for (const wall of state.walls) {
        if (lineIntersectsPolygon(wall.x1, wall.y1, wall.x2, wall.y2, testCorners)) return true;
    }

    // Check against door arcs (circle-sector intersection)
    for (const door of state.doors) {
        if (doorArcIntersects(door, testBounds, testCorners)) return true;
    }

    return false;
}

function lineIntersectsPolygon(x1, y1, x2, y2, corners) {
    for (let i = 0; i < corners.length; i++) {
        const j = (i + 1) % corners.length;
        if (segmentsIntersect(x1, y1, x2, y2, corners[i].x, corners[i].y, corners[j].x, corners[j].y)) {
            return true;
        }
    }
    // Also check if wall endpoint is inside polygon
    return pointInPolygon(x1, y1, corners) || pointInPolygon(x2, y2, corners);
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1 = cross(cx, cy, dx, dy, ax, ay);
    const d2 = cross(cx, cy, dx, dy, bx, by);
    const d3 = cross(ax, ay, bx, by, cx, cy);
    const d4 = cross(ax, ay, bx, by, dx, dy);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    return false;
}

function cross(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function pointInPolygon(px, py, corners) {
    let inside = false;
    for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
        const xi = corners[i].x, yi = corners[i].y;
        const xj = corners[j].x, yj = corners[j].y;
        if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

function doorArcIntersects(door, bounds, corners) {
    const rpx = inchesToPx(door.width);
    // Quick AABB check against arc bounding box
    const arcBounds = { x: door.x - rpx, y: door.y - rpx, w: rpx * 2, h: rpx * 2 };
    if (!aabbOverlap(bounds, arcBounds)) return false;

    // Check if any corner of the piece is within the door's arc sector
    const startAngle = door.angle * Math.PI / 180;
    const sweepDir = door.flip ? -1 : 1;
    const endAngle = startAngle + sweepDir * Math.PI / 2;

    for (const c of corners) {
        const dx = c.x - door.x, dy = c.y - door.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > rpx) continue;
        const angle = Math.atan2(dy, dx);
        if (angleInSector(angle, startAngle, endAngle, sweepDir)) return true;
    }
    return false;
}

function angleInSector(angle, start, end, dir) {
    // Normalize angles to [0, 2PI)
    const norm = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const a = norm(angle), s = norm(start), e = norm(end);
    if (dir > 0) {
        return s <= e ? (a >= s && a <= e) : (a >= s || a <= e);
    } else {
        return s >= e ? (a <= s && a >= e) : (a <= s || a >= e);
    }
}

// === Snapping ===
function snapToGrid(val) {
    const gridPx = inchesToPx(GRID_INCHES);
    return Math.round(val / gridPx) * gridPx;
}

function applySnap(dragState, dx, dy) {
    if (!state.scale) return { dx, dy };
    const piece = getPiece(dragState.ids[0]);
    const orig = dragState.origPositions[0];
    let newX = orig.x + dx;
    let newY = orig.y + dy;

    // Grid snap
    const gridPx = inchesToPx(GRID_INCHES);
    let snappedX = Math.round(newX / gridPx) * gridPx;
    let snappedY = Math.round(newY / gridPx) * gridPx;
    let sdx = snappedX - newX;
    let sdy = snappedY - newY;

    // Edge snap (check against other pieces and walls)
    const bounds = getPieceBounds(piece, newX, newY);
    const edgeSnap = findEdgeSnap(bounds, piece.id);
    if (edgeSnap.x !== null && Math.abs(edgeSnap.x) < Math.abs(sdx)) sdx = edgeSnap.x;
    if (edgeSnap.y !== null && Math.abs(edgeSnap.y) < Math.abs(sdy)) sdy = edgeSnap.y;

    // Only snap if within threshold
    const threshold = SNAP_THRESHOLD_PX / getZoomLevel();
    if (Math.abs(sdx) > threshold) sdx = 0;
    if (Math.abs(sdy) > threshold) sdy = 0;

    return { dx: dx + sdx, dy: dy + sdy, guideX: sdx !== 0 ? newX + sdx : null, guideY: sdy !== 0 ? newY + sdy : null };
}

function findEdgeSnap(bounds, excludeId) {
    let bestX = null, bestXDist = EDGE_SNAP_THRESHOLD_PX / getZoomLevel();
    let bestY = null, bestYDist = EDGE_SNAP_THRESHOLD_PX / getZoomLevel();
    const edges = { lefts: [], rights: [], tops: [], bottoms: [] };

    // Collect edges from other pieces
    state.pieces.forEach(p => {
        if (p.id === excludeId || selection.includes(p.id)) return;
        const b = getPieceBounds(p);
        edges.lefts.push(b.x);
        edges.rights.push(b.x + b.w);
        edges.tops.push(b.y);
        edges.bottoms.push(b.y + b.h);
    });

    // Collect edges from walls
    state.walls.forEach(w => {
        edges.lefts.push(Math.min(w.x1, w.x2));
        edges.rights.push(Math.max(w.x1, w.x2));
        edges.tops.push(Math.min(w.y1, w.y2));
        edges.bottoms.push(Math.max(w.y1, w.y2));
    });

    // Check all 4 edges of the dragged piece against collected edges
    const allX = [...edges.lefts, ...edges.rights];
    const allY = [...edges.tops, ...edges.bottoms];
    const myEdges = [bounds.x, bounds.x + bounds.w];
    const myEdgesY = [bounds.y, bounds.y + bounds.h];

    for (const mx of myEdges) {
        for (const ex of allX) {
            const d = Math.abs(mx - ex);
            if (d < bestXDist) { bestXDist = d; bestX = ex - mx; }
        }
    }
    for (const my of myEdgesY) {
        for (const ey of allY) {
            const d = Math.abs(my - ey);
            if (d < bestYDist) { bestYDist = d; bestY = ey - my; }
        }
    }

    return { x: bestX, y: bestY };
}

function renderSnapGuides(dragState, dx, dy, shiftHeld) {
    clearSnapGuides();
    if (shiftHeld || !state.scale) return;

    const piece = getPiece(dragState.ids[0]);
    const bounds = getPieceBounds(piece);
    const vb = state.viewBox;

    // Draw vertical alignment guide if X-edge snapped
    const edgeSnap = findEdgeSnap(bounds, piece.id);
    if (edgeSnap.x !== null) {
        const snapX = (edgeSnap.x > 0) ? bounds.x + bounds.w + edgeSnap.x : bounds.x + edgeSnap.x;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', snapX); line.setAttribute('y1', vb.y);
        line.setAttribute('x2', snapX); line.setAttribute('y2', vb.y + vb.h);
        line.classList.add('snap-guide');
        $layerGuides.appendChild(line);
    }
    // Draw horizontal alignment guide if Y-edge snapped
    if (edgeSnap.y !== null) {
        const snapY = (edgeSnap.y > 0) ? bounds.y + bounds.h + edgeSnap.y : bounds.y + edgeSnap.y;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', vb.x); line.setAttribute('y1', snapY);
        line.setAttribute('x2', vb.x + vb.w); line.setAttribute('y2', snapY);
        line.classList.add('snap-guide');
        $layerGuides.appendChild(line);
    }
}

function clearSnapGuides() {
    $layerGuides.innerHTML = '';
}

// === Rotation ===
function rotatePieces(freeRotation) {
    if (selection.length === 0) return;
    pushUndo();
    const step = freeRotation ? 1 : 45;
    selection.forEach(id => {
        const p = getPiece(id);
        if (p.locked) return;
        p.rotation = (p.rotation + step) % 360;
    });
    renderPieces();
    if (selection.length === 1) showProperties(getPiece(selection[0]));
    saveState();
}

function deleteSelected() {
    if (selection.length === 0) return;
    pushUndo();
    state.pieces = state.pieces.filter(p => !selection.includes(p.id));
    // Also delete selected doors if applicable
    clearSelection();
    renderPieces();
    updatePiecesList();
    saveState();
}

function duplicateSelected() {
    if (selection.length === 0) return;
    pushUndo();
    const newIds = [];
    selection.forEach(id => {
        const orig = getPiece(id);
        if (!orig) return;
        const offset = inchesToPx(6); // offset 6 inches
        const dupe = { ...orig, id: 'p' + (nextId++), x: orig.x + offset, y: orig.y + offset };
        state.pieces.push(dupe);
        newIds.push(dupe.id);
    });
    selection = newIds;
    renderPieces();
    updatePiecesList();
    saveState();
}

function toggleLockSelected() {
    if (selection.length === 0) return;
    pushUndo();
    selection.forEach(id => {
        const p = getPiece(id);
        if (p) p.locked = !p.locked;
    });
    renderPieces();
    if (selection.length === 1) showProperties(getPiece(selection[0]));
    saveState();
}

function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
        // Don't capture when typing in inputs
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        if (phase !== 'editor') return;

        const key = e.key.toLowerCase();

        if (key === ' ') { e.preventDefault(); spaceHeld = true; return; }
        if (key === 'escape') { clearSelection(); return; }
        if (key === 'delete' || key === 'backspace') { deleteSelected(); return; }
        if (key === 'r') { rotatePieces(e.altKey); return; }

        if (e.ctrlKey || e.metaKey) {
            if (key === 'z') {
                e.preventDefault();
                if (e.shiftKey) redo(); else undo();
                return;
            }
            if (key === 'd') { e.preventDefault(); duplicateSelected(); return; }
            if (key === 'l') { e.preventDefault(); toggleLockSelected(); return; }
        }

        // Tool shortcuts
        if (key === 'v') { tool = 'select'; setActiveTool('select'); }
    });

    document.addEventListener('keyup', (e) => {
        if (e.key === ' ') spaceHeld = false;
    });
}

// === Undo / Redo ===
function getStateSnapshot() {
    // Clone state excluding image and runtime refs
    return JSON.parse(JSON.stringify({
        walls: state.walls,
        doors: state.doors,
        pieces: state.pieces,
        scale: state.scale,
        viewBox: state.viewBox
    }));
}

function pushUndo() {
    undoStack.push(getStateSnapshot());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
}

function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(getStateSnapshot());
    const snap = undoStack.pop();
    applySnapshot(snap);
    updateUndoButtons();
}

function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(getStateSnapshot());
    const snap = redoStack.pop();
    applySnapshot(snap);
    updateUndoButtons();
}

function applySnapshot(snap) {
    state.walls = snap.walls;
    state.doors = snap.doors;
    state.pieces = snap.pieces;
    state.scale = snap.scale;
    state.viewBox = snap.viewBox;
    clearSelection();
    renderAll();
    applyViewBox();
    saveState();
}

function resetUndo() {
    undoStack = [];
    redoStack = [];
    updateUndoButtons();
}

function updateUndoButtons() {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

// === Properties Panel ===
function bindPanel() {
    // Property inputs update selected piece
    const propInputs = [$propLabel, $propWidth, $propHeight, $propRadius, $propRotation, $propCutW, $propCutH, $propCutCorner];
    propInputs.forEach(input => {
        if (!input) return;
        input.addEventListener('change', () => {
            if (selection.length !== 1) return;
            const piece = getPiece(selection[0]);
            if (!piece) return;
            pushUndo();
            piece.label = $propLabel.value;
            piece.rotation = parseInt($propRotation.value) || 0;
            if (piece.type === 'circle') {
                piece.radius = parseInt($propRadius.value) || 1;
            } else {
                piece.width = parseInt($propWidth.value) || 1;
                piece.height = parseInt($propHeight.value) || 1;
                if (piece.type === 'lshape') {
                    piece.cutWidth = parseInt($propCutW.value) || 1;
                    piece.cutHeight = parseInt($propCutH.value) || 1;
                    piece.cutCorner = $propCutCorner.value;
                }
            }
            renderPieces();
            updatePiecesList();
            saveState();
        });
    });

    // Action buttons
    document.getElementById('btn-lock').addEventListener('click', toggleLockSelected);
    document.getElementById('btn-dupe').addEventListener('click', duplicateSelected);
    document.getElementById('btn-delete').addEventListener('click', deleteSelected);

    // Add piece button — place at center of current viewBox
    document.getElementById('btn-add-piece').addEventListener('click', () => {
        const vb = state.viewBox;
        addPiece('rect', vb.x + vb.w / 2, vb.y + vb.h / 2);
    });

    // Image opacity
    $imgOpacity.addEventListener('input', () => {
        imageOpacity = parseInt($imgOpacity.value);
        $imgOpacityVal.textContent = imageOpacity + '%';
        if (state.imageEl) state.imageEl.setAttribute('opacity', imageOpacity / 100);
    });
}

function updatePiecesList() {
    $piecesList.innerHTML = '';
    state.pieces.forEach(p => {
        const div = document.createElement('div');
        div.className = 'piece-item' + (selection.includes(p.id) ? ' selected' : '') + (p.locked ? ' locked' : '');
        const dims = p.type === 'circle'
            ? `${p.radius}" r`
            : `${p.width}x${p.height}"`;
        div.innerHTML = `<span class="piece-label">${p.label || p.type}</span><span class="piece-dims">${dims}</span>`;
        div.addEventListener('click', () => selectPiece(p.id));
        $piecesList.appendChild(div);
    });
}

// === Persistence ===
const STORAGE_KEY = 'apartment-planner-state';

function saveState() {
    saveToStorage();
    saveToUrl();
}

function saveToStorage() {
    try {
        const data = serializeState();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn('localStorage save failed:', e);
    }
}

function loadFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        return restoreState(data);
    } catch (e) {
        console.warn('localStorage load failed:', e);
        return false;
    }
}

function saveToUrl() {
    try {
        const data = serializeState();
        const json = JSON.stringify(data);
        const compressed = pako.deflate(json);
        const b64 = btoa(String.fromCharCode.apply(null, compressed));

        if (b64.length > MAX_URL_BYTES) {
            // Fallback: exclude image
            const dataNoImg = { ...data, image: null };
            const jsonNoImg = JSON.stringify(dataNoImg);
            const compNoImg = pako.deflate(jsonNoImg);
            const b64NoImg = btoa(String.fromCharCode.apply(null, compNoImg));
            history.replaceState(null, '', '#' + b64NoImg);
            showBanner('Layout shared without floor plan image (too large). Recipient can upload the same image.', 'warn');
        } else {
            history.replaceState(null, '', '#' + b64);
        }
    } catch (e) {
        console.warn('URL save failed:', e);
    }
}

function loadFromUrl() {
    try {
        const hash = location.hash.slice(1);
        if (!hash) return false;
        const compressed = Uint8Array.from(atob(hash), c => c.charCodeAt(0));
        const json = pako.inflate(compressed, { to: 'string' });
        const data = JSON.parse(json);
        return restoreState(data);
    } catch (e) {
        console.warn('URL load failed:', e);
        return false;
    }
}

function showBanner(text, cls) {
    let banner = document.querySelector('.banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.className = 'banner';
        document.body.appendChild(banner);
    }
    banner.textContent = text;
    banner.className = 'banner' + (cls ? ' ' + cls : '');
    setTimeout(() => banner.remove(), 8000);
}

function serializeState() {
    return {
        image: state.image,
        scale: state.scale,
        walls: state.walls,
        doors: state.doors,
        pieces: state.pieces,
        viewBox: state.viewBox,
        imageOpacity: imageOpacity
    };
}

function restoreState(data) {
    if (!data) return false;
    state.image = data.image || null;
    state.scale = data.scale || null;
    state.walls = data.walls || [];
    state.doors = data.doors || [];
    state.pieces = data.pieces || [];
    state.viewBox = data.viewBox || { x: 0, y: 0, w: 800, h: 600 };
    imageOpacity = data.imageOpacity != null ? data.imageOpacity : DEFAULT_OPACITY;
    if ($imgOpacity) { $imgOpacity.value = imageOpacity; $imgOpacityVal.textContent = imageOpacity + '%'; }

    // Restore nextId
    state.pieces.forEach(p => {
        const num = parseInt(p.id.replace('p', ''));
        if (num >= nextId) nextId = num + 1;
    });

    // Determine phase
    if (state.image) {
        setPhase('editor');
        // Reconstruct image dimensions from the base64
        const img = new Image();
        img.onload = () => {
            state._imgWidth = img.width;
            state._imgHeight = img.height;
            renderAll();
            applyViewBox();
        };
        img.src = state.image;
    }
    return true;
}

// === Manual Calibration ===
let scaleLine = null; // { x1, y1, x2, y2 }

function initManualMode() {
    setPhase('editor');
    document.getElementById('tool-scale').classList.remove('hidden');
    tool = 'scale';
    setActiveTool('scale');
    showBanner('Draw a line along a known wall, then enter its length.');
}

function handleScaleClick(pt) {
    if (!scaleLine) {
        scaleLine = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
    } else {
        scaleLine.x2 = pt.x;
        scaleLine.y2 = pt.y;
        renderScaleLine();
        openScaleModal();
    }
}

function renderScaleLine() {
    if (!scaleLine) return;
    $layerGuides.innerHTML = '';
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', scaleLine.x1); line.setAttribute('y1', scaleLine.y1);
    line.setAttribute('x2', scaleLine.x2); line.setAttribute('y2', scaleLine.y2);
    line.setAttribute('stroke', '#6366f1');
    line.setAttribute('stroke-width', 2);
    line.setAttribute('stroke-dasharray', '6 3');
    $layerGuides.appendChild(line);
}

function openScaleModal() {
    document.getElementById('scale-modal').classList.remove('hidden');
    document.getElementById('btn-set-scale').addEventListener('click', () => {
        const feet = parseInt(document.getElementById('scale-feet').value) || 0;
        const inches = parseInt(document.getElementById('scale-inches').value) || 0;
        const totalInches = feet * 12 + inches;
        if (totalInches <= 0) return;
        const lineLenPx = Math.sqrt(
            (scaleLine.x2 - scaleLine.x1) ** 2 + (scaleLine.y2 - scaleLine.y1) ** 2
        );
        state.scale = { pixelsPerFoot: lineLenPx / (totalInches / 12) };
        document.getElementById('scale-modal').classList.add('hidden');
        $layerGuides.innerHTML = '';
        scaleLine = null;
        tool = 'select';
        setActiveTool('select');
        applyViewBox();
        saveState();
    }, { once: true });
}

// === Zoom Binding ===
function bindZoom() {
    $canvasWrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        const pt = svgPoint(e.clientX, e.clientY);
        zoomAt(pt.x, pt.y, e.deltaY);
    }, { passive: false });

    document.getElementById('btn-zoom-in').addEventListener('click', () => {
        const vb = state.viewBox;
        zoomAt(vb.x + vb.w / 2, vb.y + vb.h / 2, -1);
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
        const vb = state.viewBox;
        zoomAt(vb.x + vb.w / 2, vb.y + vb.h / 2, 1);
    });
}

document.addEventListener('DOMContentLoaded', init);
})();
