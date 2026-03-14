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
const MAX_STRIP_LENGTH_FT = 20;
const SMALL_FRAME_FT = 8 / 12;       // 8 inches → 0.667 feet
const LARGE_FRAME_FT = 2;            // 2 feet
const SAG_FACTOR = 0.12;
const MIN_SAG_FT = 0.05;
const CATENARY_POINTS = 30;
const GRID_PADDING = 60;

// Warm white LED color (less orange, more true warm white)
const LED_COLOR = '#fff0d8';
const LED_GLOW = '#ffe8c8';

// ── State ────────────────────────────────────────────────────────────────────
let socket = null;
let currentUser = null;
let scale = 1;
let gridOffsetX = 0;
let gridOffsetY = 0;

let activeTool = 'select';
let lines = [];
let frames = [];
let deleteRequests = [];
let snapshots = [];
let totalElements = 0;

// Line placement state
let isPlacingLine = false;
let currentLinePoints = [];
let currentLineUsed = 0;

// Frame placement state (staged confirmation)
let stagedFrame = null;  // { x, y, width, height, type }

// Interaction state
let hoveredElement = null;
let isDragging = false;
let dragTarget = null;

// Hover-to-insert-point state (Illustrator-style)
let hoverInsertPoint = null; // { lineId, segmentIndex, x, y }

// Timeline
let viewingSnapshot = null;

// Canvas
let canvas, ctx;
let mouseX = 0, mouseY = 0;

// Toast timeout
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

// ── Utility Functions ────────────────────────────────────────────────────────

function dist(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

function feetToPixel(ft) { return ft * scale; }
function pixelToFeet(px) { return px / scale; }

function gridToCanvas(fx, fy) {
  return { x: gridOffsetX + fx * scale, y: gridOffsetY + fy * scale };
}

function canvasToGrid(cx, cy) {
  return { x: (cx - gridOffsetX) / scale, y: (cy - gridOffsetY) / scale };
}

function clampToGrid(gx, gy) {
  return {
    x: Math.max(0, Math.min(GRID_WIDTH_FT, gx)),
    y: Math.max(0, Math.min(GRID_HEIGHT_FT, gy))
  };
}

function snapToMesh(gx, gy) {
  return {
    x: Math.round(gx / MESH_SPACING_FT) * MESH_SPACING_FT,
    y: Math.round(gy / MESH_SPACING_FT) * MESH_SPACING_FT
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

// ── Catenary / Gravity Physics ───────────────────────────────────────────────

function computeSegmentCurve(p1, p2, numPoints) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const hDist = Math.abs(dx);
  const sag = Math.max(hDist * SAG_FACTOR, MIN_SAG_FT);

  const points = [];
  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    const x = p1.x + t * dx;
    const y = p1.y + t * dy + sag * 4 * t * (1 - t);
    points.push({ x, y });
  }
  return points;
}

function computeLineCurve(attachmentPoints) {
  if (attachmentPoints.length < 2) return [];
  const allPoints = [];
  for (let i = 0; i < attachmentPoints.length - 1; i++) {
    const segPoints = computeSegmentCurve(
      attachmentPoints[i], attachmentPoints[i + 1], CATENARY_POINTS
    );
    if (i > 0) segPoints.shift();
    allPoints.push(...segPoints);
  }
  return allPoints;
}

function computeArcLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += dist(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y);
  }
  return len;
}

function computeSegmentArcLength(p1, p2) {
  const curve = computeSegmentCurve(p1, p2, CATENARY_POINTS);
  return computeArcLength(curve);
}

// ── Canvas Setup ─────────────────────────────────────────────────────────────

function initCanvas() {
  canvas = document.getElementById('grid-canvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

function resizeCanvas() {
  const cw = canvasContainer.clientWidth;
  const ch = canvasContainer.clientHeight;
  canvas.width = cw;
  canvas.height = ch;

  const scaleX = (cw - GRID_PADDING * 2) / GRID_WIDTH_FT;
  const scaleY = (ch - GRID_PADDING * 2) / GRID_HEIGHT_FT;
  scale = Math.min(scaleX, scaleY);

  gridOffsetX = (cw - GRID_WIDTH_FT * scale) / 2;
  gridOffsetY = (ch - GRID_HEIGHT_FT * scale) / 2;

  render();
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const displayLines = viewingSnapshot !== null ? snapshots[viewingSnapshot]?.lines || [] : lines;
  const displayFrames = viewingSnapshot !== null ? snapshots[viewingSnapshot]?.frames || [] : frames;

  drawGrid();
  drawLines(displayLines);
  drawFrames(displayFrames, displayLines);
  drawPreview();
  drawAttachmentPointHandles(displayLines);
  drawInsertPointIndicator();
}

function drawGrid() {
  const tl = gridToCanvas(0, 0);
  const br = gridToCanvas(GRID_WIDTH_FT, GRID_HEIGHT_FT);

  ctx.fillStyle = '#050508';
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  // Fine mesh grid
  ctx.strokeStyle = '#0e0e12';
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= GRID_WIDTH_FT; x += MESH_SPACING_FT) {
    const p = gridToCanvas(x, 0);
    const q = gridToCanvas(x, GRID_HEIGHT_FT);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }
  for (let y = 0; y <= GRID_HEIGHT_FT; y += MESH_SPACING_FT) {
    const p = gridToCanvas(0, y);
    const q = gridToCanvas(GRID_WIDTH_FT, y);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }

  // Structural supports every 4 feet
  ctx.strokeStyle = '#252530';
  ctx.lineWidth = 2.5;
  for (let x = 0; x <= GRID_WIDTH_FT; x += SUPPORT_SPACING_FT) {
    const p = gridToCanvas(x, 0);
    const q = gridToCanvas(x, GRID_HEIGHT_FT);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }

  // Border frame
  ctx.strokeStyle = '#333340';
  ctx.lineWidth = 3;
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
}

function drawLines(displayLines) {
  for (const line of displayLines) {
    if (line.points.length < 2) continue;

    const curve = computeLineCurve(line.points);
    const isHovered = hoveredElement?.type === 'line' && hoveredElement.id === line.id;

    ctx.save();

    // Outer glow
    ctx.shadowColor = LED_GLOW;
    ctx.shadowBlur = isHovered ? 14 : 8;
    ctx.strokeStyle = LED_COLOR;
    ctx.lineWidth = isHovered ? 2.5 : 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    for (let i = 0; i < curve.length; i++) {
      const p = gridToCanvas(curve[i].x, curve[i].y);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    // Bright inner core
    ctx.shadowBlur = 3;
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    ctx.restore();
  }
}

function drawFrames(displayFrames, displayLines) {
  for (const frame of displayFrames) {
    const fx1 = frame.x - frame.width / 2;
    const fy1 = frame.y - frame.height / 2;
    const fx2 = frame.x + frame.width / 2;
    const fy2 = frame.y + frame.height / 2;
    const tl = gridToCanvas(fx1, fy1);
    const w = feetToPixel(frame.width);
    const h = feetToPixel(frame.height);
    const isHovered = hoveredElement?.type === 'frame' && hoveredElement.id === frame.id;

    ctx.save();

    // Opaque white fabric base — real fabric blocks most direct light
    ctx.fillStyle = isHovered ? '#e8e6e2' : '#e0ddd8';
    ctx.fillRect(tl.x, tl.y, w, h);

    // ── Realistic light diffusion through fabric ──
    // Clip to frame bounds
    ctx.save();
    ctx.beginPath();
    ctx.rect(tl.x, tl.y, w, h);
    ctx.clip();

    for (const line of displayLines) {
      if (line.points.length < 2) continue;
      const curve = computeLineCurve(line.points);

      // Collect curve points that fall within or near the frame
      const nearPoints = [];
      for (const pt of curve) {
        if (pt.x >= fx1 - 0.8 && pt.x <= fx2 + 0.8 &&
            pt.y >= fy1 - 0.8 && pt.y <= fy2 + 0.8) {
          nearPoints.push(gridToCanvas(pt.x, pt.y));
        }
      }
      if (nearPoints.length === 0) continue;

      // Pass 1: Very wide, very soft ambient scatter (simulates light bouncing inside fabric)
      const scatterRadius = feetToPixel(0.7);
      for (let i = 0; i < nearPoints.length; i += 3) {
        const p = nearPoints[i];
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, scatterRadius);
        grad.addColorStop(0, 'rgba(255, 240, 216, 0.12)');
        grad.addColorStop(0.4, 'rgba(255, 235, 200, 0.06)');
        grad.addColorStop(1, 'rgba(255, 230, 190, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(p.x - scatterRadius, p.y - scatterRadius, scatterRadius * 2, scatterRadius * 2);
      }

      // Pass 2: Medium diffuse glow (main visible diffusion halo)
      const medRadius = feetToPixel(0.4);
      for (let i = 0; i < nearPoints.length; i += 2) {
        const p = nearPoints[i];
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, medRadius);
        grad.addColorStop(0, 'rgba(255, 243, 220, 0.22)');
        grad.addColorStop(0.3, 'rgba(255, 238, 210, 0.12)');
        grad.addColorStop(0.7, 'rgba(255, 232, 200, 0.04)');
        grad.addColorStop(1, 'rgba(255, 228, 195, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(p.x - medRadius, p.y - medRadius, medRadius * 2, medRadius * 2);
      }

      // Pass 3: Tight bright core (where fabric is thinnest / light strongest)
      const coreRadius = feetToPixel(0.15);
      for (const p of nearPoints) {
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, coreRadius);
        grad.addColorStop(0, 'rgba(255, 248, 235, 0.3)');
        grad.addColorStop(0.5, 'rgba(255, 242, 220, 0.12)');
        grad.addColorStop(1, 'rgba(255, 238, 210, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(p.x - coreRadius, p.y - coreRadius, coreRadius * 2, coreRadius * 2);
      }

      // Pass 4: Blurred line stroke for continuous glow path
      ctx.shadowColor = 'rgba(255, 240, 216, 0.6)';
      ctx.shadowBlur = 35;
      ctx.strokeStyle = 'rgba(255, 243, 225, 0.08)';
      ctx.lineWidth = feetToPixel(0.25);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < nearPoints.length; i++) {
        if (i === 0) ctx.moveTo(nearPoints[i].x, nearPoints[i].y);
        else ctx.lineTo(nearPoints[i].x, nearPoints[i].y);
      }
      ctx.stroke();

      // Pass 5: Even wider shadow-only stroke for outermost haze
      ctx.shadowBlur = 60;
      ctx.strokeStyle = 'rgba(255, 240, 216, 0.04)';
      ctx.lineWidth = feetToPixel(0.5);
      ctx.stroke();

      ctx.shadowBlur = 0;
    }

    ctx.restore(); // unclip

    // Frame border
    ctx.strokeStyle = isHovered ? '#b0b0b0' : '#707070';
    ctx.lineWidth = isHovered ? 2 : 1.5;
    ctx.strokeRect(tl.x, tl.y, w, h);

    ctx.restore();
  }
}

function drawAttachmentPointHandles(displayLines) {
  const showHandles = activeTool === 'select' || activeTool === 'line';
  if (!showHandles && !isPlacingLine) return;

  // Committed line handles
  if (showHandles) {
    for (const line of displayLines) {
      for (let i = 0; i < line.points.length; i++) {
        const p = gridToCanvas(line.points[i].x, line.points[i].y);

        ctx.fillStyle = '#222222';
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

  // "+" marker
  ctx.save();
  ctx.strokeStyle = LED_COLOR;
  ctx.lineWidth = 2;
  ctx.shadowColor = LED_GLOW;
  ctx.shadowBlur = 6;

  // Circle
  ctx.beginPath();
  ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
  ctx.stroke();

  // Plus sign
  ctx.beginPath();
  ctx.moveTo(p.x - 4, p.y);
  ctx.lineTo(p.x + 4, p.y);
  ctx.moveTo(p.x, p.y - 4);
  ctx.lineTo(p.x, p.y + 4);
  ctx.stroke();

  ctx.restore();
}

function drawPreview() {
  // Preview line being placed
  if (isPlacingLine && currentLinePoints.length > 0) {
    const pts = [...currentLinePoints];
    const gridMouse = canvasToGrid(mouseX, mouseY);
    const snapped = snapToMesh(gridMouse.x, gridMouse.y);
    const clamped = clampToGrid(snapped.x, snapped.y);

    const lastPt = pts[pts.length - 1];
    const previewCurve = computeSegmentCurve(lastPt, clamped, CATENARY_POINTS);
    const previewLen = computeArcLength(previewCurve);
    const wouldExceed = currentLineUsed + previewLen > MAX_STRIP_LENGTH_FT;

    // Draw committed segments of in-progress line
    if (pts.length >= 2) {
      const curve = computeLineCurve(pts);
      ctx.save();
      ctx.shadowColor = LED_GLOW;
      ctx.shadowBlur = 8;
      ctx.strokeStyle = LED_COLOR;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      for (let i = 0; i < curve.length; i++) {
        const p = gridToCanvas(curve[i].x, curve[i].y);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Preview segment to cursor
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = wouldExceed ? '#cc2222' : LED_COLOR;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.45;
    ctx.lineCap = 'round';

    const segPts = computeSegmentCurve(lastPt, clamped, CATENARY_POINTS);
    ctx.beginPath();
    for (let i = 0; i < segPts.length; i++) {
      const p = gridToCanvas(segPts[i].x, segPts[i].y);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();

    // Preview dot at cursor
    const cp = gridToCanvas(clamped.x, clamped.y);
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = wouldExceed ? '#cc2222' : LED_COLOR;
    ctx.beginPath();
    ctx.arc(cp.x, cp.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Staged frame preview (confirmed position, awaiting commit)
  if (stagedFrame) {
    const tl = gridToCanvas(stagedFrame.x - stagedFrame.width / 2, stagedFrame.y - stagedFrame.height / 2);
    const w = feetToPixel(stagedFrame.width);
    const h = feetToPixel(stagedFrame.height);

    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = 'rgba(220,220,220,0.6)';
    ctx.fillRect(tl.x, tl.y, w, h);
    ctx.strokeStyle = '#b0b0b0';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(tl.x, tl.y, w, h);
    ctx.restore();
  }

  // Free-floating frame preview following cursor (before staging)
  if ((activeTool === 'small-frame' || activeTool === 'large-frame') && !stagedFrame) {
    const frameType = activeTool === 'small-frame' ? 'small' : 'large';
    const size = frameType === 'small' ? SMALL_FRAME_FT : LARGE_FRAME_FT;
    const gp = canvasToGrid(mouseX, mouseY);
    const snapped = snapToMesh(gp.x, gp.y);
    const clamped = clampToGrid(snapped.x, snapped.y);

    const tl = gridToCanvas(clamped.x - size / 2, clamped.y - size / 2);
    const w = feetToPixel(size);
    const h = feetToPixel(size);

    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = 'rgba(200,200,200,0.5)';
    ctx.fillRect(tl.x, tl.y, w, h);
    ctx.strokeStyle = '#999999';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(tl.x, tl.y, w, h);
    ctx.restore();
  }
}

// ── Hit Testing ──────────────────────────────────────────────────────────────

function hitTestLine(gx, gy, line) {
  const curve = computeLineCurve(line.points);
  const threshold = pixelToFeet(8);
  for (let i = 1; i < curve.length; i++) {
    const d = distToSegment(gx, gy, curve[i - 1].x, curve[i - 1].y, curve[i].x, curve[i].y);
    if (d < threshold) return true;
  }
  return false;
}

function hitTestFrame(gx, gy, frame) {
  const halfW = frame.width / 2;
  const halfH = frame.height / 2;
  return gx >= frame.x - halfW && gx <= frame.x + halfW &&
         gy >= frame.y - halfH && gy <= frame.y + halfH;
}

function hitTestAttachmentPoint(gx, gy, line) {
  const threshold = pixelToFeet(10);
  for (let i = 0; i < line.points.length; i++) {
    if (dist(gx, gy, line.points[i].x, line.points[i].y) < threshold) {
      return i;
    }
  }
  return -1;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(px, py, x1, y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, x1 + t * dx, y1 + t * dy);
}

function projectOntoSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return 0;
  return Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
}

function findHoveredElement(gx, gy) {
  const displayLines = viewingSnapshot !== null ? snapshots[viewingSnapshot]?.lines || [] : lines;
  const displayFrames = viewingSnapshot !== null ? snapshots[viewingSnapshot]?.frames || [] : frames;

  for (let i = displayFrames.length - 1; i >= 0; i--) {
    if (hitTestFrame(gx, gy, displayFrames[i])) {
      return { type: 'frame', id: displayFrames[i].id, element: displayFrames[i] };
    }
  }
  for (let i = displayLines.length - 1; i >= 0; i--) {
    if (hitTestLine(gx, gy, displayLines[i])) {
      return { type: 'line', id: displayLines[i].id, element: displayLines[i] };
    }
  }
  return null;
}

// Find the nearest point on a line's curve for inserting a new mount point
function findNearestCurveInsertPoint(gx, gy, line) {
  let minDist = Infinity;
  let bestPoint = null;
  let bestSegment = -1;

  for (let seg = 0; seg < line.points.length - 1; seg++) {
    const curve = computeSegmentCurve(line.points[seg], line.points[seg + 1], CATENARY_POINTS);
    for (let i = 1; i < curve.length; i++) {
      const d = distToSegment(gx, gy, curve[i - 1].x, curve[i - 1].y, curve[i].x, curve[i].y);
      if (d < minDist) {
        minDist = d;
        const t = projectOntoSegment(gx, gy, curve[i - 1].x, curve[i - 1].y, curve[i].x, curve[i].y);
        bestPoint = {
          x: curve[i - 1].x + t * (curve[i].x - curve[i - 1].x),
          y: curve[i - 1].y + t * (curve[i].y - curve[i - 1].y)
        };
        bestSegment = seg;
      }
    }
  }

  return { dist: minDist, point: bestPoint, segmentIndex: bestSegment };
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

  // Dragging
  if (isDragging && dragTarget) {
    const snapped = snapToMesh(gp.x, gp.y);
    const clamped = clampToGrid(snapped.x, snapped.y);

    if (dragTarget.type === 'line-point') {
      const line = lines.find(l => l.id === dragTarget.id);
      if (line) {
        line.points[dragTarget.pointIndex] = { x: clamped.x, y: clamped.y };
        socket.emit('edit-line', { id: line.id, points: line.points });
      }
    } else if (dragTarget.type === 'frame') {
      const frame = frames.find(f => f.id === dragTarget.id);
      if (frame) {
        frame.x = clamped.x;
        frame.y = clamped.y;
        socket.emit('edit-frame', { id: frame.id, x: frame.x, y: frame.y });
      }
    }
    render();
    return;
  }

  // Reset hover insert point
  hoverInsertPoint = null;

  const canInsertPoint = (activeTool === 'select' || activeTool === 'line') && !isPlacingLine;

  // Hover detection for select/line tool (includes insert-point detection)
  if (canInsertPoint) {
    const prev = hoveredElement;

    // First check if near an existing attachment point
    let nearAttachmentPoint = false;
    for (const line of lines) {
      if (hitTestAttachmentPoint(gp.x, gp.y, line) >= 0) {
        nearAttachmentPoint = true;
        break;
      }
    }

    if (nearAttachmentPoint) {
      canvas.style.cursor = 'grab';
      hoveredElement = findHoveredElement(gp.x, gp.y);
    } else {
      // Check if hovering over a line's curve (for insert point)
      let foundInsert = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.points.length < 2) continue;

        const result = findNearestCurveInsertPoint(gp.x, gp.y, line);
        if (result.dist < pixelToFeet(10) && result.point) {
          hoverInsertPoint = {
            lineId: line.id,
            segmentIndex: result.segmentIndex,
            x: result.point.x,
            y: result.point.y
          };
          canvas.style.cursor = 'copy';
          foundInsert = true;
          hoveredElement = { type: 'line', id: line.id, element: line };
          break;
        }
      }

      if (!foundInsert) {
        hoveredElement = findHoveredElement(gp.x, gp.y);
        canvas.style.cursor = hoveredElement ? 'pointer' : 'crosshair';
      }
    }

    if (hoveredElement) {
      showTooltip(e.clientX, e.clientY, hoveredElement.element.authorName);
    } else {
      hideTooltip();
    }

    if (hoveredElement?.id !== prev?.id) render();
    else if (hoverInsertPoint) render();
  } else if (!isPlacingLine && (activeTool === 'small-frame' || activeTool === 'large-frame')) {
    // Frame tool hover
    hoveredElement = findHoveredElement(gp.x, gp.y);
    if (hoveredElement) {
      showTooltip(e.clientX, e.clientY, hoveredElement.element.authorName);
    } else {
      hideTooltip();
    }
    render();
  } else if (activeTool === 'delete') {
    hoveredElement = findHoveredElement(gp.x, gp.y);
    if (hoveredElement) {
      showTooltip(e.clientX, e.clientY, hoveredElement.element.authorName);
      canvas.style.cursor = 'pointer';
    } else {
      hideTooltip();
      canvas.style.cursor = 'crosshair';
    }
  } else {
    // Placing line — just re-render for preview
    hideTooltip();
    render();
  }
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (viewingSnapshot !== null) return;

  const gp = canvasToGrid(mouseX, mouseY);
  const canInteract = activeTool === 'select' || activeTool === 'line';

  if (!canInteract) return;

  // If there's a hover insert point, insert it and start dragging
  if (hoverInsertPoint && !isPlacingLine) {
    const line = lines.find(l => l.id === hoverInsertPoint.lineId);
    if (line) {
      const insertIdx = hoverInsertPoint.segmentIndex + 1;
      const snapped = snapToMesh(hoverInsertPoint.x, hoverInsertPoint.y);
      const clamped = clampToGrid(snapped.x, snapped.y);
      line.points.splice(insertIdx, 0, { x: clamped.x, y: clamped.y });
      socket.emit('edit-line', { id: line.id, points: line.points });

      isDragging = true;
      dragTarget = { type: 'line-point', id: line.id, pointIndex: insertIdx };
      hoverInsertPoint = null;
      canvas.style.cursor = 'grabbing';
      render();
      return;
    }
  }

  // Check if clicking on an existing attachment point
  if (!isPlacingLine) {
    for (const line of lines) {
      const ptIdx = hitTestAttachmentPoint(gp.x, gp.y, line);
      if (ptIdx >= 0) {
        isDragging = true;
        dragTarget = { type: 'line-point', id: line.id, pointIndex: ptIdx };
        canvas.style.cursor = 'grabbing';
        return;
      }
    }
  }

  // Check if clicking on a frame (for dragging) — only in select mode
  if (activeTool === 'select') {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (hitTestFrame(gp.x, gp.y, frames[i])) {
        isDragging = true;
        dragTarget = { type: 'frame', id: frames[i].id };
        canvas.style.cursor = 'grabbing';
        return;
      }
    }
  }
}

function onMouseUp() {
  if (isDragging) {
    isDragging = false;
    dragTarget = null;
    canvas.style.cursor = 'crosshair';
  }
}

function onClick(e) {
  if (isDragging) return;
  if (viewingSnapshot !== null) return;

  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const gp = canvasToGrid(cx, cy);

  if (gp.x < 0 || gp.x > GRID_WIDTH_FT || gp.y < 0 || gp.y > GRID_HEIGHT_FT) return;

  const snapped = snapToMesh(gp.x, gp.y);
  const clamped = clampToGrid(snapped.x, snapped.y);

  if (activeTool === 'line') {
    handleLinePlacement(clamped);
  } else if (activeTool === 'small-frame' || activeTool === 'large-frame') {
    handleFramePlacement(clamped);
  } else if (activeTool === 'delete') {
    handleDelete(gp);
  }
}

// ── Line Placement ───────────────────────────────────────────────────────────

function handleLinePlacement(gridPos) {
  // Check if user already has a committed line
  if (!isPlacingLine && userHasPlacedLine()) {
    showToast('You have already placed your LED strip.');
    return;
  }

  if (!isPlacingLine) {
    isPlacingLine = true;
    currentLinePoints = [gridPos];
    currentLineUsed = 0;
    lineStatusEl.classList.remove('hidden');
    updateLineStatus();
    return;
  }

  // Add new attachment point
  const lastPt = currentLinePoints[currentLinePoints.length - 1];
  const segmentLen = computeSegmentArcLength(lastPt, gridPos);

  if (currentLineUsed + segmentLen > MAX_STRIP_LENGTH_FT) {
    showToast('You have reached the 20 foot limit.');
    return;
  }

  currentLinePoints.push(gridPos);
  currentLineUsed += segmentLen;
  updateLineStatus();
  render();
}

function updateLineStatus() {
  const remaining = MAX_STRIP_LENGTH_FT - currentLineUsed;
  lineRemainingEl.textContent = `${remaining.toFixed(1)} ft remaining`;
}

function commitLine() {
  if (currentLinePoints.length < 2) return;
  socket.emit('place-line', { points: currentLinePoints });
  cancelLine();
}

function cancelLine() {
  isPlacingLine = false;
  currentLinePoints = [];
  currentLineUsed = 0;
  lineStatusEl.classList.add('hidden');
  render();
}

// ── Frame Placement (staged confirmation) ────────────────────────────────────

function handleFramePlacement(gridPos) {
  const frameType = activeTool === 'small-frame' ? 'small' : 'large';
  const size = frameType === 'small' ? SMALL_FRAME_FT : LARGE_FRAME_FT;

  // Check if user already placed this type
  const userFrames = frames.filter(f => f.authorId === currentUser.id && f.type === frameType);
  if (userFrames.length >= 1) {
    showToast(`You have already placed your ${frameType === 'small' ? '8"x8"' : "2'x2'"} frame.`);
    return;
  }

  // Ensure within grid
  const halfSize = size / 2;
  const fx = Math.max(halfSize, Math.min(GRID_WIDTH_FT - halfSize, gridPos.x));
  const fy = Math.max(halfSize, Math.min(GRID_HEIGHT_FT - halfSize, gridPos.y));

  // Stage the frame (or reposition if already staged)
  stagedFrame = { x: fx, y: fy, width: size, height: size, type: frameType };

  // Show confirmation bar
  frameInfoEl.textContent = frameType === 'small' ? 'Small Frame (8"×8")' : "Large Frame (2'×2')";
  frameStatusEl.classList.remove('hidden');

  render();
}

function commitFrame() {
  if (!stagedFrame) return;
  socket.emit('place-frame', stagedFrame);
  cancelFrame();
}

function cancelFrame() {
  stagedFrame = null;
  frameStatusEl.classList.add('hidden');
  render();
}

// ── Delete Handling ──────────────────────────────────────────────────────────

function handleDelete(gp) {
  const hit = findHoveredElement(gp.x, gp.y);
  if (!hit) return;

  if (hit.element.authorId === currentUser.id) {
    socket.emit('delete-own', { id: hit.id, type: hit.type });
  } else {
    socket.emit('request-delete', {
      elementId: hit.id,
      elementType: hit.type,
      elementAuthorId: hit.element.authorId,
      elementAuthorName: hit.element.authorName
    });
    showToast(`Delete request sent to ${hit.element.authorName}.`);
  }
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

function showTooltip(x, y, authorName) {
  tooltipEl.innerHTML = `<span class="author-name">${authorName}</span>`;
  tooltipEl.style.left = (x + 14) + 'px';
  tooltipEl.style.top = (y - 32) + 'px';
  tooltipEl.classList.remove('hidden');
}

function hideTooltip() {
  tooltipEl.classList.add('hidden');
}

// ── Notifications ────────────────────────────────────────────────────────────

function renderNotifications() {
  const myRequests = deleteRequests.filter(r => r.elementAuthorId === currentUser.id);

  notifList.innerHTML = '';

  if (myRequests.length === 0) {
    notifList.innerHTML = '<p style="color: var(--text-dim); font-size: 14px; text-align: center; padding: 24px; font-style: italic;">No notifications</p>';
    return;
  }

  for (const req of myRequests) {
    const div = document.createElement('div');
    div.className = `notif-item ${req.status !== 'pending' ? 'notif-resolved' : ''}`;

    div.innerHTML = `
      <div class="notif-text">
        <strong>${req.requesterName}</strong> wants to delete your ${req.elementType}
      </div>
      ${req.status === 'pending' ? `
        <div class="notif-actions">
          <button class="approve-btn" onclick="window._approveDelete('${req.id}')">Approve</button>
          <button class="deny-btn" onclick="window._denyDelete('${req.id}')">Deny</button>
        </div>
      ` : `
        <div class="notif-status ${req.status}">${req.status}</div>
      `}
    `;
    notifList.appendChild(div);
  }

  // Update badge — red exclamation mark
  const pendingCount = myRequests.filter(r => r.status === 'pending').length;
  if (pendingCount > 0) {
    notifBadge.textContent = '!';
    notifBadge.classList.remove('hidden');
  } else {
    notifBadge.classList.add('hidden');
  }
}

window._approveDelete = function(requestId) {
  socket.emit('approve-delete', { requestId });
};

window._denyDelete = function(requestId) {
  socket.emit('deny-delete', { requestId });
};

// ── Timeline ─────────────────────────────────────────────────────────────────

function renderTimeline() {
  timelineTrack.innerHTML = '';

  const currentTab = document.createElement('button');
  currentTab.className = `timeline-tab ${viewingSnapshot === null ? 'active' : ''}`;
  currentTab.textContent = 'Current';
  currentTab.addEventListener('click', () => {
    viewingSnapshot = null;
    renderTimeline();
    render();
  });
  timelineTrack.appendChild(currentTab);

  for (let i = 0; i < snapshots.length; i++) {
    const tab = document.createElement('button');
    tab.className = `timeline-tab ${viewingSnapshot === i ? 'active' : ''}`;
    tab.textContent = `${snapshots[i].elementCount} elements`;
    tab.addEventListener('click', () => {
      viewingSnapshot = i;
      renderTimeline();
      render();
    });
    timelineTrack.appendChild(tab);
  }
}

// ── Tool Selection ───────────────────────────────────────────────────────────

function initTools() {
  const toolBtns = document.querySelectorAll('.tool-btn');

  toolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;

      // Cancel any in-progress placement
      if (isPlacingLine) cancelLine();
      if (stagedFrame) cancelFrame();

      activeTool = tool;
      toolBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      canvas.style.cursor = (tool === 'select') ? 'default' : 'crosshair';

      hoverInsertPoint = null;
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
    currentUser = data.user;
    userLabel.textContent = currentUser.name;

    lines = data.state.lines;
    frames = data.state.frames;
    deleteRequests = data.state.deleteRequests;
    snapshots = data.state.snapshots;
    totalElements = data.state.totalElements;

    renderTimeline();
    renderNotifications();
    render();
  });

  socket.on('line-placed', (line) => {
    const existing = lines.findIndex(l => l.id === line.id);
    if (existing >= 0) lines[existing] = line;
    else lines.push(line);
    render();
  });

  socket.on('frame-placed', (frame) => {
    const existing = frames.findIndex(f => f.id === frame.id);
    if (existing >= 0) frames[existing] = frame;
    else frames.push(frame);
    render();
  });

  socket.on('line-updated', (line) => {
    const idx = lines.findIndex(l => l.id === line.id);
    if (idx >= 0) lines[idx] = line;
    render();
  });

  socket.on('frame-updated', (frame) => {
    const idx = frames.findIndex(f => f.id === frame.id);
    if (idx >= 0) frames[idx] = frame;
    render();
  });

  socket.on('element-deleted', (data) => {
    if (data.type === 'line') lines = lines.filter(l => l.id !== data.id);
    else frames = frames.filter(f => f.id !== data.id);
    hoveredElement = null;
    hideTooltip();
    render();
  });

  socket.on('delete-request', (req) => {
    deleteRequests.push(req);
    renderNotifications();
  });

  socket.on('delete-approved', (data) => {
    const req = deleteRequests.find(r => r.id === data.requestId);
    if (req) req.status = 'approved';
    if (data.elementType === 'line') lines = lines.filter(l => l.id !== data.elementId);
    else frames = frames.filter(f => f.id !== data.elementId);
    renderNotifications();
    render();
  });

  socket.on('delete-denied', (data) => {
    const req = deleteRequests.find(r => r.id === data.requestId);
    if (req) req.status = 'denied';
    renderNotifications();
  });

  socket.on('element-count', (count) => { totalElements = count; });

  socket.on('snapshot-added', (snapshot) => {
    snapshots.push(snapshot);
    renderTimeline();
  });
}

// ── Login ────────────────────────────────────────────────────────────────────

function initLogin() {
  enterBtn.addEventListener('click', doLogin);
  emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  fullNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') emailInput.focus(); });
}

function doLogin() {
  const name = fullNameInput.value.trim();
  const email = emailInput.value.trim();

  let valid = true;
  if (!name) { fullNameInput.style.borderColor = '#cc2222'; valid = false; }
  else { fullNameInput.style.borderColor = ''; }

  if (!email || !email.includes('@')) { emailInput.style.borderColor = '#cc2222'; valid = false; }
  else { emailInput.style.borderColor = ''; }

  if (!valid) return;

  loginScreen.classList.add('hidden');
  appDiv.classList.remove('hidden');

  initCanvas();
  initInput();
  initTools();

  document.querySelector('[data-tool="select"]').classList.add('active');

  initSocket();
  socket.emit('join', { name, email });
}

// ── Notifications toggle ─────────────────────────────────────────────────────

notifToggle.addEventListener('click', () => { notifPanel.classList.toggle('hidden'); });
closeNotifBtn.addEventListener('click', () => { notifPanel.classList.add('hidden'); });

// ── Animation Loop ───────────────────────────────────────────────────────────

function animationLoop() {
  requestAnimationFrame(animationLoop);
  if (isPlacingLine || stagedFrame || isDragging ||
      activeTool === 'small-frame' || activeTool === 'large-frame') {
    render();
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

initLogin();
requestAnimationFrame(animationLoop);

})();
