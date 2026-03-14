// ═══════════════════════════════════════════════════════════════════════════════
// COLLABORATION IN LINE — Simulation
// ═══════════════════════════════════════════════════════════════════════════════

(() => {
'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const GRID_WIDTH_FT = 40;
const GRID_HEIGHT_FT = 8;
const SUPPORT_SPACING_FT = 4;
const MESH_SPACING_FT = 0.5;
const SNAP_FT = 1 / 12;              // 1 inch snap for fine placement
const MAX_STRIP_LENGTH_FT = 20;
const SMALL_FRAME_FT = 8 / 12;
const LARGE_FRAME_FT = 2;
const SAG_FACTOR = 0.12;
const MIN_SAG_FT = 0.05;
const CATENARY_POINTS = 30;
const GRID_PADDING = 60;

const LED_COLOR = '#fff0d8';
const LED_GLOW = '#ffe8c8';
const LED_LINE_WIDTH = 0.8;           // reduced line weight

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

// ── State ────────────────────────────────────────────────────────────────────
let socket = null;
let currentUser = null;

// Zoom / Pan
let baseScale = 1;                    // pixels per foot at zoom 1
let zoomLevel = 1;
let viewCenterX = GRID_WIDTH_FT / 2;
let viewCenterY = GRID_HEIGHT_FT / 2;
let isPanning = false;
let panLastX = 0, panLastY = 0;

let activeTool = 'select';
let lines = [];
let frames = [];
let deleteRequests = [];
let snapshots = [];
let totalElements = 0;

// Line placement
let isPlacingLine = false;
let currentLinePoints = [];
let currentLineUsed = 0;

// Frame placement (staged)
let stagedFrame = null;

// Selection — only selected element shows handles
let selectedElement = null;           // { type: 'line'|'frame', id }

// Interaction
let hoveredElement = null;
let isDragging = false;
let dragTarget = null;
let hoverInsertPoint = null;

// Timeline
let viewingSnapshot = null;

// Canvas
let canvas, ctx;
let mouseX = 0, mouseY = 0;
let toastTimer = null;

// ── DOM Elements ─────────────────────────────────────────────────────────────
const loginScreen = document.getElementById('login-screen');
const appDiv = document.getElementById('app');
const fullNameInput = document.getElementById('full-name');
const emailInput = document.getElementById('email');
const enterBtn = document.getElementById('enter-btn');
const userLabel = document.getElementById('user-label');
const tooltipEl = document.getElementById('tooltip');

const lineStatusEl = document.getElementById('line-status');
const lineRemainingEl = document.getElementById('line-remaining');
const commitLineBtn = document.getElementById('commit-line-btn');
const cancelLineBtn = document.getElementById('cancel-line-btn');

const frameStatusEl = document.getElementById('frame-status');
const frameInfoEl = document.getElementById('frame-info');
const commitFrameBtn = document.getElementById('commit-frame-btn');
const cancelFrameBtn = document.getElementById('cancel-frame-btn');

const toastEl = document.getElementById('toast');
const toastMsgEl = document.getElementById('toast-message');

const notifToggle = document.getElementById('notifications-toggle');
const notifBadge = document.getElementById('notif-badge');
const notifPanel = document.getElementById('notifications-panel');
const notifList = document.getElementById('notifications-list');
const closeNotifBtn = document.getElementById('close-notifications');
const timelineTrack = document.getElementById('timeline-track');
const canvasContainer = document.getElementById('canvas-container');
const zoomSlider = document.getElementById('zoom-slider');
const zoomLabel = document.getElementById('zoom-label');

// ── Utility ──────────────────────────────────────────────────────────────────

function dist(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

function effScale() { return baseScale * zoomLevel; }
function feetToPixel(ft) { return ft * effScale(); }
function pixelToFeet(px) { return px / effScale(); }

function gridToCanvas(fx, fy) {
  const s = effScale();
  return {
    x: canvas.width / 2 + (fx - viewCenterX) * s,
    y: canvas.height / 2 + (fy - viewCenterY) * s
  };
}

function canvasToGrid(cx, cy) {
  const s = effScale();
  return {
    x: (cx - canvas.width / 2) / s + viewCenterX,
    y: (cy - canvas.height / 2) / s + viewCenterY
  };
}

function clampToGrid(gx, gy) {
  return {
    x: Math.max(0, Math.min(GRID_WIDTH_FT, gx)),
    y: Math.max(0, Math.min(GRID_HEIGHT_FT, gy))
  };
}

function snapToMesh(gx, gy) {
  return {
    x: Math.round(gx / SNAP_FT) * SNAP_FT,
    y: Math.round(gy / SNAP_FT) * SNAP_FT
  };
}

function showToast(msg, duration) {
  if (toastTimer) clearTimeout(toastTimer);
  toastMsgEl.textContent = msg;
  toastEl.classList.remove('hidden');
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), duration || 3000);
}

function userHasPlacedLine() {
  return lines.some(l => l.authorId === currentUser?.id);
}

function isSelected(type, id) {
  return selectedElement && selectedElement.type === type && selectedElement.id === id;
}

// ── Catenary / Gravity Physics ───────────────────────────────────────────────

function computeSegmentCurve(p1, p2, numPoints) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const sag = Math.max(Math.abs(dx) * SAG_FACTOR, MIN_SAG_FT);
  const points = [];
  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    points.push({ x: p1.x + t * dx, y: p1.y + t * dy + sag * 4 * t * (1 - t) });
  }
  return points;
}

function computeLineCurve(pts) {
  if (pts.length < 2) return [];
  const all = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = computeSegmentCurve(pts[i], pts[i + 1], CATENARY_POINTS);
    if (i > 0) seg.shift();
    all.push(...seg);
  }
  return all;
}

function computeArcLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y);
  return len;
}

function computeSegmentArcLength(p1, p2) {
  return computeArcLength(computeSegmentCurve(p1, p2, CATENARY_POINTS));
}

// ── Canvas Setup ─────────────────────────────────────────────────────────────

function initCanvas() {
  canvas = document.getElementById('grid-canvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

function resizeCanvas() {
  const cw = canvasContainer.clientWidth, ch = canvasContainer.clientHeight;
  canvas.width = cw;
  canvas.height = ch;
  const sx = (cw - GRID_PADDING * 2) / GRID_WIDTH_FT;
  const sy = (ch - GRID_PADDING * 2) / GRID_HEIGHT_FT;
  baseScale = Math.min(sx, sy);
  render();
}

// ── Zoom ─────────────────────────────────────────────────────────────────────

function setZoom(newZoom, centerCx, centerCy) {
  newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
  if (centerCx !== undefined && centerCy !== undefined) {
    // Keep point under cursor fixed
    const gp = canvasToGrid(centerCx, centerCy);
    zoomLevel = newZoom;
    viewCenterX = gp.x - (centerCx - canvas.width / 2) / effScale();
    viewCenterY = gp.y - (centerCy - canvas.height / 2) / effScale();
  } else {
    zoomLevel = newZoom;
  }
  zoomSlider.value = Math.round(zoomLevel * 100);
  zoomLabel.textContent = Math.round(zoomLevel * 100) + '%';
  render();
}

function initZoom() {
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.002;
    setZoom(zoomLevel * (1 + delta), mouseX, mouseY);
  }, { passive: false });

  zoomSlider.addEventListener('input', () => {
    setZoom(parseInt(zoomSlider.value) / 100);
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const dl = viewingSnapshot !== null ? snapshots[viewingSnapshot]?.lines || [] : lines;
  const df = viewingSnapshot !== null ? snapshots[viewingSnapshot]?.frames || [] : frames;

  drawGrid();
  drawLines(dl);
  drawFrames(df, dl);
  drawPreview();
  drawSelectedHandles(dl);
  drawInsertPointIndicator();
}

function drawGrid() {
  const tl = gridToCanvas(0, 0), br = gridToCanvas(GRID_WIDTH_FT, GRID_HEIGHT_FT);

  ctx.fillStyle = '#050508';
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  // Fine mesh
  ctx.strokeStyle = '#0e0e12';
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= GRID_WIDTH_FT; x += MESH_SPACING_FT) {
    const p = gridToCanvas(x, 0), q = gridToCanvas(x, GRID_HEIGHT_FT);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }
  for (let y = 0; y <= GRID_HEIGHT_FT; y += MESH_SPACING_FT) {
    const p = gridToCanvas(0, y), q = gridToCanvas(GRID_WIDTH_FT, y);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }

  // Structural supports
  ctx.strokeStyle = '#252530';
  ctx.lineWidth = 2.5;
  for (let x = 0; x <= GRID_WIDTH_FT; x += SUPPORT_SPACING_FT) {
    const p = gridToCanvas(x, 0), q = gridToCanvas(x, GRID_HEIGHT_FT);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }

  // Border
  ctx.strokeStyle = '#333340';
  ctx.lineWidth = 3;
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
}

function drawLines(dl) {
  for (const line of dl) {
    if (line.points.length < 2) continue;
    const curve = computeLineCurve(line.points);
    const hovered = hoveredElement?.type === 'line' && hoveredElement.id === line.id;
    const sel = isSelected('line', line.id);

    ctx.save();
    ctx.shadowColor = LED_GLOW;
    ctx.shadowBlur = (hovered || sel) ? 10 : 6;
    ctx.strokeStyle = LED_COLOR;
    ctx.lineWidth = (hovered || sel) ? LED_LINE_WIDTH * 1.4 : LED_LINE_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    for (let i = 0; i < curve.length; i++) {
      const p = gridToCanvas(curve[i].x, curve[i].y);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    // Inner core
    ctx.shadowBlur = 2;
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.3;
    ctx.stroke();
    ctx.restore();
  }
}

function drawFrames(df, dl) {
  for (const frame of df) {
    const fx1 = frame.x - frame.width / 2, fy1 = frame.y - frame.height / 2;
    const fx2 = frame.x + frame.width / 2, fy2 = frame.y + frame.height / 2;
    const tl = gridToCanvas(fx1, fy1);
    const w = feetToPixel(frame.width), h = feetToPixel(frame.height);
    const hovered = hoveredElement?.type === 'frame' && hoveredElement.id === frame.id;
    const sel = isSelected('frame', frame.id);

    ctx.save();

    // Off-white fabric base
    ctx.fillStyle = (hovered || sel) ? '#d0cdc6' : '#c8c4bc';
    ctx.fillRect(tl.x, tl.y, w, h);

    // ── Diffusion: pure white feathered line ──
    ctx.save();
    ctx.beginPath();
    ctx.rect(tl.x, tl.y, w, h);
    ctx.clip();

    for (const line of dl) {
      if (line.points.length < 2) continue;
      const curve = computeLineCurve(line.points);

      // Collect points within frame
      const near = [];
      for (const pt of curve) {
        if (pt.x >= fx1 - 0.3 && pt.x <= fx2 + 0.3 &&
            pt.y >= fy1 - 0.3 && pt.y <= fy2 + 0.3) {
          near.push(gridToCanvas(pt.x, pt.y));
        }
      }
      if (near.length < 2) continue;

      // Build the sub-path
      function strokeNear() {
        ctx.beginPath();
        for (let i = 0; i < near.length; i++) {
          if (i === 0) ctx.moveTo(near[i].x, near[i].y);
          else ctx.lineTo(near[i].x, near[i].y);
        }
        ctx.stroke();
      }

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Outer feather (wide, very soft)
      ctx.shadowColor = 'rgba(255,255,255,0.4)';
      ctx.shadowBlur = 18;
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = LED_LINE_WIDTH * 5;
      strokeNear();

      // Mid feather
      ctx.shadowBlur = 10;
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = LED_LINE_WIDTH * 3;
      strokeNear();

      // Core — pure white at 1.5× line weight
      ctx.shadowBlur = 5;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = LED_LINE_WIDTH * 1.5;
      strokeNear();

      // Bright center
      ctx.shadowBlur = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = LED_LINE_WIDTH * 0.8;
      strokeNear();

      ctx.shadowBlur = 0;
    }

    ctx.restore(); // unclip

    // Frame border
    ctx.strokeStyle = (hovered || sel) ? '#a0a0a0' : '#606060';
    ctx.lineWidth = (hovered || sel) ? 2 : 1.5;
    ctx.strokeRect(tl.x, tl.y, w, h);

    ctx.restore();
  }
}

function drawSelectedHandles(dl) {
  // Only draw handles for the selected line
  if (selectedElement?.type === 'line') {
    const line = dl.find(l => l.id === selectedElement.id);
    if (line) {
      for (let i = 0; i < line.points.length; i++) {
        const p = gridToCanvas(line.points[i].x, line.points[i].y);
        ctx.fillStyle = '#111111';
        ctx.strokeStyle = LED_COLOR;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // Current placement points
  if (isPlacingLine) {
    for (const pt of currentLinePoints) {
      const p = gridToCanvas(pt.x, pt.y);
      ctx.fillStyle = '#111111';
      ctx.strokeStyle = LED_COLOR;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

function drawInsertPointIndicator() {
  if (!hoverInsertPoint) return;
  const p = gridToCanvas(hoverInsertPoint.x, hoverInsertPoint.y);
  ctx.save();
  ctx.strokeStyle = LED_COLOR;
  ctx.lineWidth = 2;
  ctx.shadowColor = LED_GLOW;
  ctx.shadowBlur = 6;
  ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x - 4, p.y); ctx.lineTo(p.x + 4, p.y);
  ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x, p.y + 4);
  ctx.stroke();
  ctx.restore();
}

function drawPreview() {
  // Line preview
  if (isPlacingLine && currentLinePoints.length > 0) {
    const pts = [...currentLinePoints];
    const gm = canvasToGrid(mouseX, mouseY);
    const clamped = clampToGrid(snapToMesh(gm.x, gm.y).x, snapToMesh(gm.x, gm.y).y);
    const lastPt = pts[pts.length - 1];
    const pLen = computeArcLength(computeSegmentCurve(lastPt, clamped, CATENARY_POINTS));
    const exceed = currentLineUsed + pLen > MAX_STRIP_LENGTH_FT;

    if (pts.length >= 2) {
      const curve = computeLineCurve(pts);
      ctx.save();
      ctx.shadowColor = LED_GLOW; ctx.shadowBlur = 6;
      ctx.strokeStyle = LED_COLOR; ctx.lineWidth = LED_LINE_WIDTH;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = 0.6;
      ctx.beginPath();
      for (let i = 0; i < curve.length; i++) {
        const p = gridToCanvas(curve[i].x, curve[i].y);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke(); ctx.restore();
    }

    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = exceed ? '#cc2222' : LED_COLOR;
    ctx.lineWidth = 0.6; ctx.globalAlpha = 0.45; ctx.lineCap = 'round';
    const segPts = computeSegmentCurve(lastPt, clamped, CATENARY_POINTS);
    ctx.beginPath();
    for (let i = 0; i < segPts.length; i++) {
      const p = gridToCanvas(segPts[i].x, segPts[i].y);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke(); ctx.restore();

    const cp = gridToCanvas(clamped.x, clamped.y);
    ctx.save(); ctx.globalAlpha = 0.4;
    ctx.fillStyle = exceed ? '#cc2222' : LED_COLOR;
    ctx.beginPath(); ctx.arc(cp.x, cp.y, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Staged frame
  if (stagedFrame) {
    const tl = gridToCanvas(stagedFrame.x - stagedFrame.width / 2, stagedFrame.y - stagedFrame.height / 2);
    const w = feetToPixel(stagedFrame.width), h = feetToPixel(stagedFrame.height);
    ctx.save(); ctx.globalAlpha = 0.7;
    ctx.fillStyle = 'rgba(200,196,188,0.6)'; ctx.fillRect(tl.x, tl.y, w, h);
    ctx.strokeStyle = '#a0a0a0'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.strokeRect(tl.x, tl.y, w, h); ctx.restore();
  }

  // Cursor-following frame preview
  if ((activeTool === 'small-frame' || activeTool === 'large-frame') && !stagedFrame) {
    const size = activeTool === 'small-frame' ? SMALL_FRAME_FT : LARGE_FRAME_FT;
    const gm = canvasToGrid(mouseX, mouseY);
    const s = snapToMesh(gm.x, gm.y);
    const c = clampToGrid(s.x, s.y);
    const tl = gridToCanvas(c.x - size / 2, c.y - size / 2);
    const w = feetToPixel(size), h = feetToPixel(size);
    ctx.save(); ctx.globalAlpha = 0.3;
    ctx.fillStyle = 'rgba(190,186,178,0.5)'; ctx.fillRect(tl.x, tl.y, w, h);
    ctx.strokeStyle = '#888'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
    ctx.strokeRect(tl.x, tl.y, w, h); ctx.restore();
  }
}

// ── Hit Testing ──────────────────────────────────────────────────────────────

function hitTestLine(gx, gy, line) {
  const curve = computeLineCurve(line.points);
  const thresh = pixelToFeet(8);
  for (let i = 1; i < curve.length; i++) {
    if (distToSeg(gx, gy, curve[i - 1].x, curve[i - 1].y, curve[i].x, curve[i].y) < thresh) return true;
  }
  return false;
}

function hitTestFrame(gx, gy, f) {
  return gx >= f.x - f.width / 2 && gx <= f.x + f.width / 2 &&
         gy >= f.y - f.height / 2 && gy <= f.y + f.height / 2;
}

function hitTestAttachPt(gx, gy, line) {
  const thresh = pixelToFeet(10);
  for (let i = 0; i < line.points.length; i++) {
    if (dist(gx, gy, line.points[i].x, line.points[i].y) < thresh) return i;
  }
  return -1;
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(px, py, x1, y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return dist(px, py, x1 + t * dx, y1 + t * dy);
}

function projOnSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return 0;
  return Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
}

function findHovered(gx, gy) {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (hitTestFrame(gx, gy, frames[i])) return { type: 'frame', id: frames[i].id, element: frames[i] };
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (hitTestLine(gx, gy, lines[i])) return { type: 'line', id: lines[i].id, element: lines[i] };
  }
  return null;
}

function findInsertPoint(gx, gy, line) {
  let minD = Infinity, best = null, bestSeg = -1;
  for (let s = 0; s < line.points.length - 1; s++) {
    const curve = computeSegmentCurve(line.points[s], line.points[s + 1], CATENARY_POINTS);
    for (let i = 1; i < curve.length; i++) {
      const d = distToSeg(gx, gy, curve[i - 1].x, curve[i - 1].y, curve[i].x, curve[i].y);
      if (d < minD) {
        minD = d;
        const t = projOnSeg(gx, gy, curve[i - 1].x, curve[i - 1].y, curve[i].x, curve[i].y);
        best = { x: curve[i - 1].x + t * (curve[i].x - curve[i - 1].x), y: curve[i - 1].y + t * (curve[i].y - curve[i - 1].y) };
        bestSeg = s;
      }
    }
  }
  return { dist: minD, point: best, segmentIndex: bestSeg };
}

// ── Input Handling ───────────────────────────────────────────────────────────

function initInput() {
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function onMouseMove(e) {
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
  const gp = canvasToGrid(mouseX, mouseY);

  // Panning
  if (isPanning) {
    const dx = mouseX - panLastX, dy = mouseY - panLastY;
    viewCenterX -= dx / effScale();
    viewCenterY -= dy / effScale();
    panLastX = mouseX; panLastY = mouseY;
    render();
    return;
  }

  // Dragging
  if (isDragging && dragTarget) {
    const s = snapToMesh(gp.x, gp.y);
    const c = clampToGrid(s.x, s.y);
    if (dragTarget.type === 'line-point') {
      const line = lines.find(l => l.id === dragTarget.id);
      if (line) { line.points[dragTarget.pointIndex] = { x: c.x, y: c.y }; socket.emit('edit-line', { id: line.id, points: line.points }); }
    } else if (dragTarget.type === 'frame') {
      const frame = frames.find(f => f.id === dragTarget.id);
      if (frame) { frame.x = c.x; frame.y = c.y; socket.emit('edit-frame', { id: frame.id, x: frame.x, y: frame.y }); }
    }
    render(); return;
  }

  hoverInsertPoint = null;
  const notPlacing = !isPlacingLine;

  // Check hover for selected line insert points
  if (notPlacing && selectedElement?.type === 'line') {
    const selLine = lines.find(l => l.id === selectedElement.id);
    if (selLine) {
      // Near attachment point?
      if (hitTestAttachPt(gp.x, gp.y, selLine) >= 0) {
        canvas.style.cursor = 'grab';
        hoveredElement = { type: 'line', id: selLine.id, element: selLine };
        hideTooltip(); render(); return;
      }
      // Near curve for insert?
      const res = findInsertPoint(gp.x, gp.y, selLine);
      if (res.dist < pixelToFeet(10) && res.point) {
        hoverInsertPoint = { lineId: selLine.id, segmentIndex: res.segmentIndex, x: res.point.x, y: res.point.y };
        canvas.style.cursor = 'copy';
        hoveredElement = { type: 'line', id: selLine.id, element: selLine };
        hideTooltip(); render(); return;
      }
    }
  }

  // General hover
  const prev = hoveredElement;
  hoveredElement = findHovered(gp.x, gp.y);

  if (hoveredElement && !(isSelected(hoveredElement.type, hoveredElement.id))) {
    showTooltipEdit(e.clientX, e.clientY, hoveredElement.element.authorName);
    canvas.style.cursor = 'pointer';
  } else {
    hideTooltip();
    canvas.style.cursor = (activeTool === 'select') ? 'default' : 'crosshair';
  }

  if (hoveredElement?.id !== prev?.id) render();

  // Frame/line preview re-render
  if (isPlacingLine || stagedFrame || activeTool === 'small-frame' || activeTool === 'large-frame') render();
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (viewingSnapshot !== null) return;
  const gp = canvasToGrid(mouseX, mouseY);

  // Insert point on selected line
  if (hoverInsertPoint && !isPlacingLine) {
    const line = lines.find(l => l.id === hoverInsertPoint.lineId);
    if (line) {
      const idx = hoverInsertPoint.segmentIndex + 1;
      const s = snapToMesh(hoverInsertPoint.x, hoverInsertPoint.y);
      const c = clampToGrid(s.x, s.y);
      line.points.splice(idx, 0, { x: c.x, y: c.y });
      socket.emit('edit-line', { id: line.id, points: line.points });
      isDragging = true;
      dragTarget = { type: 'line-point', id: line.id, pointIndex: idx };
      hoverInsertPoint = null;
      canvas.style.cursor = 'grabbing';
      render(); return;
    }
  }

  // Drag attachment point of selected line
  if (!isPlacingLine && selectedElement?.type === 'line') {
    const selLine = lines.find(l => l.id === selectedElement.id);
    if (selLine) {
      const ptIdx = hitTestAttachPt(gp.x, gp.y, selLine);
      if (ptIdx >= 0) {
        isDragging = true;
        dragTarget = { type: 'line-point', id: selLine.id, pointIndex: ptIdx };
        canvas.style.cursor = 'grabbing';
        return;
      }
    }
  }

  // Drag frames — in select, small-frame, or large-frame tool
  const canDragFrame = activeTool === 'select' || activeTool === 'small-frame' || activeTool === 'large-frame';
  if (canDragFrame && !stagedFrame) {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (hitTestFrame(gp.x, gp.y, frames[i])) {
        isDragging = true;
        dragTarget = { type: 'frame', id: frames[i].id };
        selectedElement = { type: 'frame', id: frames[i].id };
        canvas.style.cursor = 'grabbing';
        render(); return;
      }
    }
  }

  // Pan if zoomed and clicking on empty space
  if (zoomLevel > 1.05 && !hoveredElement) {
    isPanning = true;
    panLastX = mouseX;
    panLastY = mouseY;
    canvas.style.cursor = 'grabbing';
    return;
  }
}

function onMouseUp() {
  if (isDragging) { isDragging = false; dragTarget = null; }
  if (isPanning) { isPanning = false; }
  canvas.style.cursor = (activeTool === 'select') ? 'default' : 'crosshair';
}

function onClick(e) {
  if (isDragging || isPanning) return;
  if (viewingSnapshot !== null) return;
  const rect = canvas.getBoundingClientRect();
  const gp = canvasToGrid(e.clientX - rect.left, e.clientY - rect.top);

  // Select/deselect on click
  const hit = findHovered(gp.x, gp.y);

  if (activeTool === 'delete') {
    if (hit) handleDelete(gp);
    return;
  }

  if (activeTool === 'line') {
    if (hit && !isPlacingLine) {
      // Click on element → select it
      selectedElement = { type: hit.type, id: hit.id };
      render(); return;
    }
    if (!hit && !isPlacingLine) { selectedElement = null; }
    // Line placement
    if (gp.x >= 0 && gp.x <= GRID_WIDTH_FT && gp.y >= 0 && gp.y <= GRID_HEIGHT_FT) {
      const s = snapToMesh(gp.x, gp.y);
      handleLinePlacement(clampToGrid(s.x, s.y));
    }
    render(); return;
  }

  if (activeTool === 'small-frame' || activeTool === 'large-frame') {
    if (hit && !stagedFrame) {
      selectedElement = { type: hit.type, id: hit.id };
      render(); return;
    }
    if (!hit && !stagedFrame) { selectedElement = null; }
    if (gp.x >= 0 && gp.x <= GRID_WIDTH_FT && gp.y >= 0 && gp.y <= GRID_HEIGHT_FT) {
      const s = snapToMesh(gp.x, gp.y);
      handleFramePlacement(clampToGrid(s.x, s.y));
    }
    render(); return;
  }

  // Select tool
  if (hit) {
    selectedElement = { type: hit.type, id: hit.id };
  } else {
    selectedElement = null;
  }
  render();
}

// ── Line Placement ───────────────────────────────────────────────────────────

function handleLinePlacement(gridPos) {
  if (!isPlacingLine && userHasPlacedLine()) { showToast('You have already placed your LED strip.'); return; }
  if (!isPlacingLine) {
    isPlacingLine = true; currentLinePoints = [gridPos]; currentLineUsed = 0;
    lineStatusEl.classList.remove('hidden'); updateLineStatus(); return;
  }
  const lastPt = currentLinePoints[currentLinePoints.length - 1];
  const segLen = computeSegmentArcLength(lastPt, gridPos);
  if (currentLineUsed + segLen > MAX_STRIP_LENGTH_FT) { showToast('You have reached the 20 foot limit.'); return; }
  currentLinePoints.push(gridPos);
  currentLineUsed += segLen;
  updateLineStatus(); render();
}

function updateLineStatus() {
  lineRemainingEl.textContent = `${(MAX_STRIP_LENGTH_FT - currentLineUsed).toFixed(1)} ft remaining`;
}

function commitLine() {
  if (currentLinePoints.length < 2) return;
  socket.emit('place-line', { points: currentLinePoints });
  cancelLine();
}

function cancelLine() {
  isPlacingLine = false; currentLinePoints = []; currentLineUsed = 0;
  lineStatusEl.classList.add('hidden'); render();
}

// ── Frame Placement ──────────────────────────────────────────────────────────

function handleFramePlacement(gridPos) {
  const ftype = activeTool === 'small-frame' ? 'small' : 'large';
  const size = ftype === 'small' ? SMALL_FRAME_FT : LARGE_FRAME_FT;
  if (frames.filter(f => f.authorId === currentUser.id && f.type === ftype).length >= 1) {
    showToast(`You have already placed your ${ftype === 'small' ? '8"x8"' : "2'x2'"} frame.`); return;
  }
  const hs = size / 2;
  const fx = Math.max(hs, Math.min(GRID_WIDTH_FT - hs, gridPos.x));
  const fy = Math.max(hs, Math.min(GRID_HEIGHT_FT - hs, gridPos.y));
  stagedFrame = { x: fx, y: fy, width: size, height: size, type: ftype };
  frameInfoEl.textContent = ftype === 'small' ? 'Small Frame (8"×8")' : "Large Frame (2'×2')";
  frameStatusEl.classList.remove('hidden'); render();
}

function commitFrame() { if (!stagedFrame) return; socket.emit('place-frame', stagedFrame); cancelFrame(); }
function cancelFrame() { stagedFrame = null; frameStatusEl.classList.add('hidden'); render(); }

// ── Delete ───────────────────────────────────────────────────────────────────

function handleDelete(gp) {
  const hit = findHovered(gp.x, gp.y);
  if (!hit) return;
  if (hit.element.authorId === currentUser.id) {
    socket.emit('delete-own', { id: hit.id, type: hit.type });
  } else {
    socket.emit('request-delete', { elementId: hit.id, elementType: hit.type, elementAuthorId: hit.element.authorId, elementAuthorName: hit.element.authorName });
    showToast(`Delete request sent to ${hit.element.authorName}.`);
  }
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

function showTooltipEdit(x, y, authorName) {
  tooltipEl.innerHTML = `<span class="author-name">${authorName}</span><span class="edit-hint">Click to Edit</span>`;
  tooltipEl.style.left = (x + 14) + 'px';
  tooltipEl.style.top = (y - 42) + 'px';
  tooltipEl.classList.remove('hidden');
}

function hideTooltip() { tooltipEl.classList.add('hidden'); }

// ── Notifications ────────────────────────────────────────────────────────────

function renderNotifications() {
  const my = deleteRequests.filter(r => r.elementAuthorId === currentUser.id);
  notifList.innerHTML = '';
  if (my.length === 0) { notifList.innerHTML = '<p style="color:var(--text-dim);font-size:14px;text-align:center;padding:24px;font-style:italic">No notifications</p>'; return; }
  for (const req of my) {
    const div = document.createElement('div');
    div.className = `notif-item ${req.status !== 'pending' ? 'notif-resolved' : ''}`;
    div.innerHTML = `<div class="notif-text"><strong>${req.requesterName}</strong> wants to delete your ${req.elementType}</div>
      ${req.status === 'pending' ? `<div class="notif-actions"><button class="approve-btn" onclick="window._approveDelete('${req.id}')">Approve</button><button class="deny-btn" onclick="window._denyDelete('${req.id}')">Deny</button></div>` : `<div class="notif-status ${req.status}">${req.status}</div>`}`;
    notifList.appendChild(div);
  }
  const pending = my.filter(r => r.status === 'pending').length;
  if (pending > 0) { notifBadge.textContent = '!'; notifBadge.classList.remove('hidden'); }
  else { notifBadge.classList.add('hidden'); }
}

window._approveDelete = (id) => socket.emit('approve-delete', { requestId: id });
window._denyDelete = (id) => socket.emit('deny-delete', { requestId: id });

// ── Timeline ─────────────────────────────────────────────────────────────────

function renderTimeline() {
  timelineTrack.innerHTML = '';
  const ct = document.createElement('button');
  ct.className = `timeline-tab ${viewingSnapshot === null ? 'active' : ''}`;
  ct.textContent = 'Current';
  ct.addEventListener('click', () => { viewingSnapshot = null; renderTimeline(); render(); });
  timelineTrack.appendChild(ct);
  for (let i = 0; i < snapshots.length; i++) {
    const t = document.createElement('button');
    t.className = `timeline-tab ${viewingSnapshot === i ? 'active' : ''}`;
    t.textContent = `${snapshots[i].elementCount} elements`;
    t.addEventListener('click', () => { viewingSnapshot = i; renderTimeline(); render(); });
    timelineTrack.appendChild(t);
  }
}

// ── Tool Selection ───────────────────────────────────────────────────────────

function initTools() {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isPlacingLine) cancelLine();
      if (stagedFrame) cancelFrame();
      activeTool = btn.dataset.tool;
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedElement = null;
      hoverInsertPoint = null;
      canvas.style.cursor = (activeTool === 'select') ? 'default' : 'crosshair';
      render();
    });
  });
  commitLineBtn.addEventListener('click', commitLine);
  cancelLineBtn.addEventListener('click', cancelLine);
  commitFrameBtn.addEventListener('click', commitFrame);
  cancelFrameBtn.addEventListener('click', cancelFrame);
}

// ── Socket Events ────────────────────────────────────────────────────────────

function initSocket() {
  socket = io();
  socket.on('joined', (data) => {
    currentUser = data.user; userLabel.textContent = currentUser.name;
    lines = data.state.lines; frames = data.state.frames;
    deleteRequests = data.state.deleteRequests; snapshots = data.state.snapshots;
    totalElements = data.state.totalElements;
    renderTimeline(); renderNotifications(); render();
  });
  socket.on('line-placed', (l) => { const i = lines.findIndex(x => x.id === l.id); if (i >= 0) lines[i] = l; else lines.push(l); render(); });
  socket.on('frame-placed', (f) => { const i = frames.findIndex(x => x.id === f.id); if (i >= 0) frames[i] = f; else frames.push(f); render(); });
  socket.on('line-updated', (l) => { const i = lines.findIndex(x => x.id === l.id); if (i >= 0) lines[i] = l; render(); });
  socket.on('frame-updated', (f) => { const i = frames.findIndex(x => x.id === f.id); if (i >= 0) frames[i] = f; render(); });
  socket.on('element-deleted', (d) => { if (d.type === 'line') lines = lines.filter(l => l.id !== d.id); else frames = frames.filter(f => f.id !== d.id); hoveredElement = null; selectedElement = null; hideTooltip(); render(); });
  socket.on('delete-request', (r) => { deleteRequests.push(r); renderNotifications(); });
  socket.on('delete-approved', (d) => { const r = deleteRequests.find(x => x.id === d.requestId); if (r) r.status = 'approved'; if (d.elementType === 'line') lines = lines.filter(l => l.id !== d.elementId); else frames = frames.filter(f => f.id !== d.elementId); renderNotifications(); render(); });
  socket.on('delete-denied', (d) => { const r = deleteRequests.find(x => x.id === d.requestId); if (r) r.status = 'denied'; renderNotifications(); });
  socket.on('element-count', (c) => { totalElements = c; });
  socket.on('snapshot-added', (s) => { snapshots.push(s); renderTimeline(); });
}

// ── Login ────────────────────────────────────────────────────────────────────

function initLogin() {
  enterBtn.addEventListener('click', doLogin);
  emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  fullNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') emailInput.focus(); });
}

function doLogin() {
  const name = fullNameInput.value.trim(), email = emailInput.value.trim();
  let ok = true;
  if (!name) { fullNameInput.style.borderColor = '#cc2222'; ok = false; } else fullNameInput.style.borderColor = '';
  if (!email || !email.includes('@')) { emailInput.style.borderColor = '#cc2222'; ok = false; } else emailInput.style.borderColor = '';
  if (!ok) return;
  loginScreen.classList.add('hidden'); appDiv.classList.remove('hidden');
  initCanvas(); initInput(); initTools(); initZoom();
  document.querySelector('[data-tool="select"]').classList.add('active');
  initSocket(); socket.emit('join', { name, email });
}

// ── Toggles ──────────────────────────────────────────────────────────────────

notifToggle.addEventListener('click', () => notifPanel.classList.toggle('hidden'));
closeNotifBtn.addEventListener('click', () => notifPanel.classList.add('hidden'));

// ── Animation Loop ───────────────────────────────────────────────────────────

function animLoop() {
  requestAnimationFrame(animLoop);
  if (isPlacingLine || stagedFrame || isDragging || isPanning || activeTool === 'small-frame' || activeTool === 'large-frame') render();
}

// ── Init ─────────────────────────────────────────────────────────────────────

initLogin();
requestAnimationFrame(animLoop);

})();
