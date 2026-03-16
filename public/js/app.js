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

let activeTool = 'view';
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
let hoveredPointIndex = -1;           // index of hovered attachment point on selected line
let selectedPointIndex = -1;          // index of clicked/selected point (for deletion)

// Timeline
let viewingSnapshot = null;

// Canvas
let canvas, ctx;
let mouseX = 0, mouseY = 0;
let toastTimer = null;
let isAdmin = false;

// Undo stack — stores snapshots of state before each action in this session
const undoStack = [];
const MAX_UNDO = 50;

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
const playheadSlider = document.getElementById('playhead-slider');
const playheadTicks = document.getElementById('playhead-ticks');
const playheadInfo = document.getElementById('playhead-info');
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

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const mon = d.toLocaleString('default', { month: 'short' });
  const day = d.getDate();
  const hr = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');
  const ampm = hr >= 12 ? 'PM' : 'AM';
  const h12 = hr % 12 || 12;
  return `${mon} ${day}, ${h12}:${min} ${ampm}`;
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

// ── Undo System ──────────────────────────────────────────────────────────────

function saveUndo() {
  // Snapshot only elements owned by or edited by the current user
  const snap = {
    lines: lines.map(l => ({ ...l, points: l.points.map(p => ({ ...p })) })),
    frames: frames.map(f => ({ ...f }))
  };
  undoStack.push(snap);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function performUndo() {
  if (undoStack.length === 0) { showToast('Nothing to undo.'); return; }
  const snap = undoStack.pop();

  // Restore lines — only revert lines that the current user owns or has edited
  // We restore the full state from the snapshot to keep it simple and correct
  lines.length = 0;
  for (const l of snap.lines) lines.push(l);

  frames.length = 0;
  for (const f of snap.frames) frames.push(f);

  // Sync all changes to server
  for (const l of lines) socket.emit('edit-line', { id: l.id, points: l.points });
  for (const f of frames) socket.emit('edit-frame', { id: f.id, x: f.x, y: f.y });

  selectedElement = null;
  selectedPointIndex = -1;
  render();
  showToast('Undone.');
}

// ── Catenary / Gravity Physics ───────────────────────────────────────────────

function computeSegmentCurve(p1, p2, numPoints) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const span = Math.sqrt(dx * dx + dy * dy);
  const hDist = Math.abs(dx);

  // Tension model: when points are within 1 foot, reduce sag proportionally
  // At 1ft apart the strip is taut with minimal droop, at 0ft it's straight
  let tension = 1;
  if (span <= 1) {
    tension = span * span; // quadratic falloff — very tight when close
  }

  const sag = Math.max(hDist * SAG_FACTOR * tension, MIN_SAG_FT * tension);
  const points = [];
  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    points.push({ x: p1.x + t * dx, y: p1.y + t * dy + sag * 4 * t * (1 - t) });
  }
  return points;
}

// Curve cache to avoid recomputing on every render
const curveCache = new Map();

function getCurveKey(pts) {
  let k = '';
  for (const p of pts) k += p.x.toFixed(4) + ',' + p.y.toFixed(4) + ';';
  return k;
}

function computeLineCurve(pts) {
  if (pts.length < 2) return [];
  const key = getCurveKey(pts);
  if (curveCache.has(key)) return curveCache.get(key);
  const all = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = computeSegmentCurve(pts[i], pts[i + 1], CATENARY_POINTS);
    if (i > 0) seg.shift();
    all.push(...seg);
  }
  // Keep cache small
  if (curveCache.size > 500) curveCache.clear();
  curveCache.set(key, all);
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

function computeTotalLineLength(pts) {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    total += computeSegmentArcLength(pts[i], pts[i + 1]);
  }
  return total;
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

  // Ease viewCenter back to grid center as zoom approaches 1
  // At zoom 1.0 → fully centered, at zoom 2+ → no correction
  const defaultCX = GRID_WIDTH_FT / 2, defaultCY = GRID_HEIGHT_FT / 2;
  const t = Math.max(0, Math.min(1, (zoomLevel - 1))); // 0 at zoom=1, 1 at zoom>=2
  viewCenterX = defaultCX + (viewCenterX - defaultCX) * t;
  viewCenterY = defaultCY + (viewCenterY - defaultCY) * t;

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
  if (leaderboardHighlight) {
    drawLines(dl, { dimExcept: leaderboardHighlight.lineId, dimAlpha: 0.12 });
  } else {
    drawLines(dl);
  }
  drawFrames(df, dl);
  drawPreview();
  drawSelectedHandles(dl);
  drawInsertPointIndicator();
  drawLeaderboardLabel();
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

function isLineVisible(pts) {
  // Quick check if any point is within the viewport
  for (const p of pts) {
    const cp = gridToCanvas(p.x, p.y);
    if (cp.x > -200 && cp.x < canvas.width + 200 && cp.y > -200 && cp.y < canvas.height + 200) return true;
  }
  return false;
}

function drawLines(dl, opts) {
  // opts: { dimExcept: lineId, dimAlpha: 0.15 }
  for (const line of dl) {
    if (line.points.length < 2) continue;
    if (!opts && !isLineVisible(line.points)) continue;
    const curve = computeLineCurve(line.points);
    const hovered = hoveredElement?.type === 'line' && hoveredElement.id === line.id;
    const sel = isSelected('line', line.id);
    const isDimmed = opts?.dimExcept && line.id !== opts.dimExcept;

    ctx.save();
    if (isDimmed) ctx.globalAlpha = opts.dimAlpha || 0.15;
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

      // Feathered glow (2 passes instead of 4 for performance)
      ctx.shadowColor = 'rgba(255,255,255,0.4)';
      ctx.shadowBlur = 14;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = LED_LINE_WIDTH * 4;
      strokeNear();

      // Core — pure white at 1.5× line weight
      ctx.shadowBlur = 4;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = LED_LINE_WIDTH * 1.5;
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
      const atLimit = computeTotalLineLength(line.points) >= MAX_STRIP_LENGTH_FT - 0.05;
      const isOthers = !isAdmin && line.authorId !== currentUser?.id;
      for (let i = 0; i < line.points.length; i++) {
        const p = gridToCanvas(line.points[i].x, line.points[i].y);
        const isEndpoint = (i === 0 || i === line.points.length - 1);
        const isLocked = isEndpoint && isOthers;

        if (isLocked) {
          // Locked endpoint on someone else's line — dim, non-interactive
          ctx.fillStyle = '#0a0a0a';
          ctx.strokeStyle = '#444444';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (atLimit) {
          // At length limit — red ring
          ctx.fillStyle = '#1a0808';
          ctx.strokeStyle = '#cc2222';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.strokeStyle = 'rgba(204,34,34,0.5)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p.x - 2, p.y); ctx.lineTo(p.x + 2, p.y);
          ctx.stroke();
        } else if (i === selectedPointIndex) {
          // Selected point — solid white, ready for deletion
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (i === hoveredPointIndex) {
          // Hovered point — highlighted outline
          ctx.fillStyle = '#222222';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          // Normal editable point
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

function drawLeaderboardLabel() {
  if (!leaderboardHighlight) return;
  const line = lines.find(l => l.id === leaderboardHighlight.lineId);
  if (!line || line.points.length < 2) return;

  // Find the topmost point of the line to place the label above it
  let topPt = line.points[0];
  for (const p of line.points) {
    if (p.y < topPt.y) topPt = p;
  }

  const cp = gridToCanvas(topPt.x, topPt.y);
  const name = leaderboardHighlight.authorName;

  // Draw label background
  ctx.save();
  ctx.font = '13px "Cormorant Garamond", Georgia, serif';
  ctx.textAlign = 'center';
  const tw = ctx.measureText(name).width;
  const px = cp.x, py = cp.y - 18;

  ctx.fillStyle = 'rgba(8,8,8,0.85)';
  ctx.beginPath();
  ctx.roundRect(px - tw / 2 - 10, py - 12, tw + 20, 22, 3);
  ctx.fill();
  ctx.strokeStyle = 'rgba(192,192,192,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#e0e0e0';
  ctx.fillText(name, px, py + 4);
  ctx.restore();

  // Extra glow pass on the highlighted line
  const curve = computeLineCurve(line.points);
  ctx.save();
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 18;
  ctx.strokeStyle = LED_COLOR;
  ctx.lineWidth = LED_LINE_WIDTH * 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    const p = gridToCanvas(curve[i].x, curve[i].y);
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
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

function hitTestLine(gx, gy, line, wide) {
  // Quick bounding box check to skip lines far from the click
  const pts = line.points;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const margin = 1.5; // account for sag + hit threshold
  if (gx < minX - margin || gx > maxX + margin || gy < minY - margin || gy > maxY + margin) return false;

  const curve = computeLineCurve(pts);
  const thresh = pixelToFeet(wide ? 24 : 14);
  for (let i = 1; i < curve.length; i++) {
    if (distToSeg(gx, gy, curve[i - 1].x, curve[i - 1].y, curve[i].x, curve[i].y) < thresh) return true;
  }
  return false;
}

function hitTestFrame(gx, gy, f) {
  return gx >= f.x - f.width / 2 && gx <= f.x + f.width / 2 &&
         gy >= f.y - f.height / 2 && gy <= f.y + f.height / 2;
}

function hitTestAttachPt(gx, gy, line, wide, skipEndpoints) {
  const thresh = pixelToFeet(wide ? 22 : 10);
  for (let i = 0; i < line.points.length; i++) {
    // Skip first and last points if editing someone else's line
    if (skipEndpoints && (i === 0 || i === line.points.length - 1)) continue;
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

function findHoveredByType(gx, gy, type) {
  if (type === 'frame') {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (hitTestFrame(gx, gy, frames[i])) return { type: 'frame', id: frames[i].id, element: frames[i] };
    }
  } else if (type === 'line') {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (hitTestLine(gx, gy, lines[i])) return { type: 'line', id: lines[i].id, element: lines[i] };
    }
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

  document.addEventListener('keydown', (e) => {
    // Don't intercept if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Cmd+Z / Ctrl+Z — undo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      performUndo();
      return;
    }

    // Delete attachment point with Delete or Backspace key
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;

    if (activeTool !== 'line' || !selectedElement || selectedElement.type !== 'line') return;
    if (selectedPointIndex < 0) return;

    const line = lines.find(l => l.id === selectedElement.id);
    if (!line) return;

    if (line.points.length <= 2) {
      showToast('Cannot delete — a line needs at least 2 points.');
      return;
    }

    const isOthers = !isAdmin && line.authorId !== currentUser?.id;
    if (isOthers && (selectedPointIndex === 0 || selectedPointIndex === line.points.length - 1)) {
      showToast('Cannot delete another user\'s start or end point.');
      return;
    }

    e.preventDefault();
    saveUndo();
    line.points.splice(selectedPointIndex, 1);
    selectedPointIndex = -1;
    hoveredPointIndex = -1;
    socket.emit('edit-line', { id: line.id, points: line.points });
    render();
  });
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
      if (line) {
        const oldPt = { ...line.points[dragTarget.pointIndex] };
        const oldLen = computeTotalLineLength(line.points);
        line.points[dragTarget.pointIndex] = { x: c.x, y: c.y };
        const newLen = computeTotalLineLength(line.points);
        // Allow if staying under limit, or if the move shortens the line
        if (newLen > MAX_STRIP_LENGTH_FT && newLen > oldLen) {
          line.points[dragTarget.pointIndex] = oldPt; // revert — would make it longer
        } else {
          socket.emit('edit-line', { id: line.id, points: line.points });
        }
      }
    } else if (dragTarget.type === 'frame') {
      const frame = frames.find(f => f.id === dragTarget.id);
      if (frame) { frame.x = c.x; frame.y = c.y; socket.emit('edit-frame', { id: frame.id, x: frame.x, y: frame.y }); }
    }
    render(); return;
  }

  hoverInsertPoint = null;
  hoveredPointIndex = -1;
  const notPlacing = !isPlacingLine;
  const isLineTool = activeTool === 'line';
  const isFrameTool = activeTool === 'small-frame' || activeTool === 'large-frame';

  // Check hover for selected line handles (only in line tool)
  if (isLineTool && notPlacing && selectedElement?.type === 'line') {
    const selLine = lines.find(l => l.id === selectedElement.id);
    if (selLine) {
      const isOthers = !isAdmin && selLine.authorId !== currentUser?.id;
      const ptIdx = hitTestAttachPt(gp.x, gp.y, selLine, true, isOthers);
      if (ptIdx >= 0) {
        hoveredPointIndex = ptIdx;
        canvas.style.cursor = 'grab';
        hoveredElement = { type: 'line', id: selLine.id, element: selLine };
        hideTooltip(); render(); return;
      }
      const res = findInsertPoint(gp.x, gp.y, selLine);
      if (res.dist < pixelToFeet(20) && res.point) {
        hoverInsertPoint = { lineId: selLine.id, segmentIndex: res.segmentIndex, x: res.point.x, y: res.point.y };
        canvas.style.cursor = 'copy';
        hoveredElement = { type: 'line', id: selLine.id, element: selLine };
        hideTooltip(); render(); return;
      }
    }
  }

  // Scoped hover detection — each tool only sees its own element type
  const prev = hoveredElement;
  if (activeTool === 'view') {
    hoveredElement = findHovered(gp.x, gp.y); // view sees everything (read-only)
  } else if (isLineTool) {
    hoveredElement = findHoveredByType(gp.x, gp.y, 'line');
  } else if (isFrameTool) {
    hoveredElement = findHoveredByType(gp.x, gp.y, 'frame');
  } else if (activeTool === 'delete') {
    hoveredElement = findHovered(gp.x, gp.y);
  } else {
    hoveredElement = null;
  }

  if (hoveredElement && !(isSelected(hoveredElement.type, hoveredElement.id))) {
    if (activeTool === 'view') {
      showTooltipView(e.clientX, e.clientY, hoveredElement.element.authorName);
    } else {
      showTooltipEdit(e.clientX, e.clientY, hoveredElement.element.authorName);
    }
    canvas.style.cursor = 'pointer';
  } else {
    hideTooltip();
    canvas.style.cursor = (activeTool === 'view') ? 'default' : 'crosshair';
  }

  if (hoveredElement?.id !== prev?.id) requestRender();

  // Preview re-render
  if (isPlacingLine || stagedFrame || isFrameTool) requestRender();
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (viewingSnapshot !== null) return;
  const gp = canvasToGrid(mouseX, mouseY);

  // View mode — only panning
  if (activeTool === 'view') {
    isPanning = true;
    panLastX = mouseX; panLastY = mouseY;
    canvas.style.cursor = 'grabbing';
    return;
  }

  // Insert point on selected line (line tool only)
  if (activeTool === 'line' && hoverInsertPoint && !isPlacingLine) {
    const line = lines.find(l => l.id === hoverInsertPoint.lineId);
    if (line) {
      const idx = hoverInsertPoint.segmentIndex + 1;
      const s = snapToMesh(hoverInsertPoint.x, hoverInsertPoint.y);
      const c = clampToGrid(s.x, s.y);
      saveUndo();
      line.points.splice(idx, 0, { x: c.x, y: c.y });
      const overLimit = computeTotalLineLength(line.points) > MAX_STRIP_LENGTH_FT;
      socket.emit('edit-line', { id: line.id, points: line.points });
      // Notify owner if editing someone else's line
      if (line.authorId !== currentUser?.id) {
        socket.emit('notify-edit', { lineId: line.id, authorId: line.authorId, authorName: line.authorName });
      }
      if (overLimit) {
        // Point is inserted but locked — user can see it but can't drag it
        showToast('Point added but locked — shorten the line to unlock it.');
        hoverInsertPoint = null;
        render(); return;
      }
      isDragging = true;
      dragTarget = { type: 'line-point', id: line.id, pointIndex: idx };
      hoverInsertPoint = null;
      canvas.style.cursor = 'grabbing';
      render(); return;
    }
  }

  // Drag attachment point of selected line (line tool only, wide hitbox)
  if (activeTool === 'line' && !isPlacingLine && selectedElement?.type === 'line') {
    const selLine = lines.find(l => l.id === selectedElement.id);
    if (selLine) {
      const isOthers = !isAdmin && selLine.authorId !== currentUser?.id;
      const ptIdx = hitTestAttachPt(gp.x, gp.y, selLine, true, isOthers);
      if (ptIdx >= 0) {
        // Select this point (will confirm on mouseUp if no drag)
        selectedPointIndex = ptIdx;
        saveUndo();
        isDragging = true;
        dragTarget = { type: 'line-point', id: selLine.id, pointIndex: ptIdx };
        canvas.style.cursor = 'grabbing';
        if (isOthers && !dragTarget._notified) {
          socket.emit('notify-edit', { lineId: selLine.id, authorId: selLine.authorId, authorName: selLine.authorName });
          dragTarget._notified = true;
        }
        render();
        return;
      }
    }
  }

  // Drag frames — only in frame tools
  const canDragFrame = activeTool === 'small-frame' || activeTool === 'large-frame';
  if (canDragFrame && !stagedFrame) {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (hitTestFrame(gp.x, gp.y, frames[i])) {
        saveUndo();
        isDragging = true;
        dragTarget = { type: 'frame', id: frames[i].id };
        selectedElement = { type: 'frame', id: frames[i].id };
        canvas.style.cursor = 'grabbing';
        render(); return;
      }
    }
  }

  // Pan if zoomed and clicking on empty space (in editing tools)
  if (zoomLevel > 1.05 && !hoveredElement && activeTool !== 'view') {
    isPanning = true;
    panLastX = mouseX;
    panLastY = mouseY;
    canvas.style.cursor = 'grabbing';
    return;
  }
}

let justFinishedDrag = false;

function onMouseUp() {
  if (isDragging) {
    isDragging = false;
    dragTarget = null;
    justFinishedDrag = true;
    setTimeout(() => { justFinishedDrag = false; }, 100); // auto-clear safety
  }
  if (isPanning) {
    isPanning = false;
    justFinishedDrag = true;
    setTimeout(() => { justFinishedDrag = false; }, 100);
  }
  canvas.style.cursor = (activeTool === 'view') ? 'default' : 'crosshair';
}

function onClick(e) {
  // Swallow the click that follows a drag/pan release
  if (justFinishedDrag) { justFinishedDrag = false; return; }
  if (isDragging || isPanning) return;
  if (viewingSnapshot !== null) return;
  const rect = canvas.getBoundingClientRect();
  const gp = canvasToGrid(e.clientX - rect.left, e.clientY - rect.top);

  // View mode — no editing on click
  if (activeTool === 'view') return;

  // Check if click is near the selected element (wider zone) — don't deselect
  let nearSelected = false;
  if (selectedElement?.type === 'line') {
    const selLine = lines.find(l => l.id === selectedElement.id);
    if (selLine) {
      const isOthers = !isAdmin && selLine.authorId !== currentUser?.id;
      if (hitTestAttachPt(gp.x, gp.y, selLine, true, isOthers) >= 0) nearSelected = true;
      else if (hitTestLine(gp.x, gp.y, selLine, true)) nearSelected = true;
    }
  } else if (selectedElement?.type === 'frame') {
    const selFrame = frames.find(f => f.id === selectedElement.id);
    if (selFrame && hitTestFrame(gp.x, gp.y, selFrame)) nearSelected = true;
  }

  // Scoped hit detection
  const isLineTool = activeTool === 'line';
  const isFrameTool = activeTool === 'small-frame' || activeTool === 'large-frame';
  let hit;
  if (isLineTool) hit = findHoveredByType(gp.x, gp.y, 'line');
  else if (isFrameTool) hit = findHoveredByType(gp.x, gp.y, 'frame');
  else hit = findHovered(gp.x, gp.y);

  if (activeTool === 'delete') {
    if (hit) handleDelete(gp);
    return;
  }

  if (isLineTool) {
    if (hit && !isPlacingLine) {
      selectedElement = { type: hit.type, id: hit.id };
      selectedPointIndex = -1;
      render(); return;
    }
    if (!hit && !nearSelected && !isPlacingLine) { selectedElement = null; selectedPointIndex = -1; }
    if (gp.x >= 0 && gp.x <= GRID_WIDTH_FT && gp.y >= 0 && gp.y <= GRID_HEIGHT_FT) {
      if (!nearSelected) {
        const s = snapToMesh(gp.x, gp.y);
        handleLinePlacement(clampToGrid(s.x, s.y));
      }
    }
    render(); return;
  }

  if (isFrameTool) {
    // Only select frames matching the current tool type for editing
    const toolFtype = activeTool === 'small-frame' ? 'small' : 'large';
    const matchingHit = hit && hit.element.type === toolFtype;

    if (matchingHit && !stagedFrame) {
      selectedElement = { type: hit.type, id: hit.id };
      render(); return;
    }
    if (!matchingHit && !nearSelected && !stagedFrame) { selectedElement = null; }
    // Always allow placement — don't block on nearSelected for frame tools
    if (gp.x >= 0 && gp.x <= GRID_WIDTH_FT && gp.y >= 0 && gp.y <= GRID_HEIGHT_FT) {
      if (!stagedFrame) {
        const s = snapToMesh(gp.x, gp.y);
        handleFramePlacement(clampToGrid(s.x, s.y));
      }
    }
    render(); return;
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
  saveUndo();
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

function commitFrame() { if (!stagedFrame) return; saveUndo(); socket.emit('place-frame', stagedFrame); cancelFrame(); }
function cancelFrame() { stagedFrame = null; frameStatusEl.classList.add('hidden'); render(); }

// ── Delete ───────────────────────────────────────────────────────────────────

function handleDelete(gp) {
  const hit = findHovered(gp.x, gp.y);
  if (!hit) return;
  saveUndo();
  if (hit.element.authorId === currentUser.id || isAdmin) {
    socket.emit('delete-own', { id: hit.id, type: hit.type, admin: isAdmin });
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

function showTooltipView(x, y, authorName) {
  tooltipEl.innerHTML = `<span class="author-name">${authorName}</span>`;
  tooltipEl.style.left = (x + 14) + 'px';
  tooltipEl.style.top = (y - 32) + 'px';
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
    if (req.status === 'info') {
      // Edit notification — info only, no action needed
      div.className = 'notif-item notif-info';
      div.innerHTML = `<div class="notif-text">${req.message || `<strong>${req.requesterName}</strong> edited your line`}</div>`;
    } else {
      div.className = `notif-item ${req.status !== 'pending' ? 'notif-resolved' : ''}`;
      div.innerHTML = `<div class="notif-text"><strong>${req.requesterName}</strong> wants to delete your ${req.elementType}</div>
        ${req.status === 'pending' ? `<div class="notif-actions"><button class="approve-btn" data-action="approve" data-id="${req.id}">Approve</button><button class="deny-btn" data-action="deny" data-id="${req.id}">Deny</button></div>` : `<div class="notif-status ${req.status}">${req.status}</div>`}`;
    }
    notifList.appendChild(div);
  }
  const actionable = my.filter(r => r.status === 'pending' || r.status === 'info').length;
  if (actionable > 0) { notifBadge.textContent = '!'; notifBadge.classList.remove('hidden'); }
  else { notifBadge.classList.add('hidden'); }
}

// Event delegation for notification buttons
notifList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  if (action === 'approve') socket.emit('approve-delete', { requestId: id });
  else if (action === 'deny') socket.emit('deny-delete', { requestId: id });
});

// ── Timeline ─────────────────────────────────────────────────────────────────

function renderTimeline() {
  const total = snapshots.length; // 0 = no snapshots yet
  playheadSlider.max = total;     // max = snapshots.length, value at max = "Current"
  playheadSlider.value = viewingSnapshot !== null ? viewingSnapshot : total;

  // Render tick marks for each snapshot
  playheadTicks.innerHTML = '';
  if (total > 0) {
    for (let i = 0; i < total; i++) {
      const tick = document.createElement('div');
      tick.className = 'playhead-tick';
      tick.style.left = (total > 0 ? (i / total) * 100 : 0) + '%';
      const sName = snapshots[i].editorName || ('Snapshot ' + (i + 1));
      const sTime = formatTimestamp(snapshots[i].timestamp);
      tick.title = sTime ? `${sName} — ${sTime}` : sName;
      playheadTicks.appendChild(tick);
    }
  }

  updatePlayheadInfo();
}

function updatePlayheadInfo() {
  const val = parseInt(playheadSlider.value);
  const total = snapshots.length;
  if (val >= total) {
    playheadInfo.textContent = 'Current';
  } else {
    const snap = snapshots[val];
    const name = snap.editorName || ('Snapshot ' + (val + 1));
    const time = formatTimestamp(snap.timestamp);
    playheadInfo.textContent = time ? `${name} — ${time}` : name;
  }
}

function initPlayhead() {
  playheadSlider.addEventListener('input', () => {
    const val = parseInt(playheadSlider.value);
    if (val >= snapshots.length) {
      viewingSnapshot = null;
    } else {
      viewingSnapshot = val;
    }
    updatePlayheadInfo();
    render();
  });
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
      hoveredElement = null;
      hoverInsertPoint = null;
      selectedPointIndex = -1;
      justFinishedDrag = false;
      isDragging = false;
      isPanning = false;
      dragTarget = null;
      hideTooltip();
      canvas.style.cursor = (activeTool === 'view') ? 'default' : 'crosshair';
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
    // Auto-activate admin if previously granted
    if (currentUser.isAdmin) {
      isAdmin = true;
      adminToggle.style.borderColor = '#cc2222';
      adminToggle.style.color = '#cc2222';
    }
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
  socket.on('element-count', () => { /* legacy, ignored */ });
  socket.on('line-edited-notification', (data) => {
    // Only show if I'm the author of the line being edited
    if (data.authorId !== currentUser?.id) return;
    // Avoid duplicate notifications from the same editor in quick succession
    const recent = deleteRequests.find(r => r.status === 'info' && r.requesterId === data.editorId && r.elementId === data.lineId);
    if (recent) return;
    deleteRequests.push({
      id: data.id,
      requesterId: data.editorId,
      requesterName: data.editorName,
      elementId: data.lineId,
      elementType: 'line',
      elementAuthorId: currentUser.id,
      elementAuthorName: currentUser.name,
      status: 'info',
      message: data.message
    });
    renderNotifications();
  });
  socket.on('user-joined', (data) => {
    if (!isAdmin) return;
    if (data.id === currentUser?.id) return; // don't notify about yourself
    playNotifSound();
    showToast(`${data.name} joined.`);
  });
  socket.on('snapshot-added', (s) => {
    const wasAtCurrent = viewingSnapshot === null;
    snapshots.push(s);
    if (wasAtCurrent) viewingSnapshot = null; // stay at current
    renderTimeline();
  });
}

// ── Login ────────────────────────────────────────────────────────────────────

let emailLookupTimer = null;

function initLogin() {
  enterBtn.addEventListener('click', doLogin);
  emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  fullNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') emailInput.focus(); });

  // Auto-fill name when a known email is typed
  emailInput.addEventListener('input', () => {
    clearTimeout(emailLookupTimer);
    const email = emailInput.value.trim();
    if (!email || !email.includes('@')) return;
    emailLookupTimer = setTimeout(() => {
      fetch('/api/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      })
      .then(r => r.json())
      .then(data => {
        if (data.found && data.name) {
          fullNameInput.value = data.name;
          fullNameInput.style.borderColor = '';
          fullNameInput.disabled = true;
          fullNameInput.style.opacity = '0.6';
        } else {
          fullNameInput.disabled = false;
          fullNameInput.style.opacity = '1';
        }
      })
      .catch(() => {});
    }, 400);
  });
}

function doLogin() {
  const name = fullNameInput.value.trim(), email = emailInput.value.trim();
  let ok = true;
  if (!name) { fullNameInput.style.borderColor = '#cc2222'; ok = false; } else fullNameInput.style.borderColor = '';
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailValid) { emailInput.style.borderColor = '#cc2222'; ok = false; showToast('Please enter a valid email address.'); } else emailInput.style.borderColor = '';
  if (!ok) return;
  loginScreen.classList.add('hidden'); appDiv.classList.remove('hidden');
  if (window._startMusic) window._startMusic();
  initCanvas(); initInput(); initTools(); initZoom(); initPlayhead();
  document.querySelector('[data-tool="view"]').classList.add('active');
  initSocket(); socket.emit('join', { name, email });
}

// ── PDF Export ───────────────────────────────────────────────────────────────

function exportPDF() {
  // Render the current or snapshot view to a temporary high-res canvas, then convert to PDF
  const pdfW = 1600, pdfH = pdfW * (GRID_HEIGHT_FT / GRID_WIDTH_FT) + 80;
  const offscreen = document.createElement('canvas');
  offscreen.width = pdfW;
  offscreen.height = pdfH;
  const oc = offscreen.getContext('2d');

  // Save current state
  const savedCtx = ctx, savedCanvas = canvas;
  const savedBaseScale = baseScale, savedZoom = zoomLevel;
  const savedVCX = viewCenterX, savedVCY = viewCenterY;

  // Temporarily swap to offscreen
  canvas = offscreen;
  ctx = oc;
  baseScale = (pdfW - 40) / GRID_WIDTH_FT;
  zoomLevel = 1;
  viewCenterX = GRID_WIDTH_FT / 2;
  viewCenterY = GRID_HEIGHT_FT / 2;

  // White background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, pdfW, pdfH);

  const dl = viewingSnapshot !== null ? snapshots[viewingSnapshot]?.lines || [] : lines;
  const df = viewingSnapshot !== null ? snapshots[viewingSnapshot]?.frames || [] : frames;

  // Shift down a bit for title
  ctx.save();
  ctx.translate(0, 40);
  drawGrid();
  drawLines(dl);
  drawFrames(df, dl);
  ctx.restore();

  // Title: project name + date
  const ts = viewingSnapshot !== null ? snapshots[viewingSnapshot]?.timestamp : Date.now();
  const dateStr = formatTimestamp(ts);
  ctx.fillStyle = '#c0c0c0';
  ctx.font = '20px "Cormorant Garamond", Georgia, serif';
  ctx.textAlign = 'left';
  ctx.fillText('Collaboration in Line', 20, 28);
  ctx.fillStyle = '#777777';
  ctx.font = '14px "Cormorant Garamond", Georgia, serif';
  ctx.textAlign = 'right';
  ctx.fillText(dateStr, pdfW - 20, 28);

  // Restore
  canvas = savedCanvas;
  ctx = savedCtx;
  baseScale = savedBaseScale;
  zoomLevel = savedZoom;
  viewCenterX = savedVCX;
  viewCenterY = savedVCY;

  // Convert to image and trigger download as PDF-like image
  // For true PDF we'd need a library, but a high-res PNG is more practical
  const link = document.createElement('a');
  link.download = 'collaboration-in-line' + (viewingSnapshot !== null ? `-snapshot-${viewingSnapshot + 1}` : '') + '.png';
  link.href = offscreen.toDataURL('image/png');
  link.click();
}

const pdfBtn = document.getElementById('pdf-download');
pdfBtn.addEventListener('click', exportPDF);

// ── Survey & Leaderboard ─────────────────────────────────────────────────────

let surveyActive = false;
let leaderboardHighlight = null; // { lineId, authorName }
let surveyLines = [];
let surveyIndex = 0;
let surveyRatings = [];

const leaderboardToggle = document.getElementById('leaderboard-toggle');
const surveyModal = document.getElementById('survey-modal');
const surveyImage = document.getElementById('survey-line-image');
const surveyInfo = document.getElementById('survey-line-info');
const surveyProgress = document.getElementById('survey-progress');
const surveyRatingBtns = document.getElementById('survey-rating-buttons');
const surveyCancelBtn = document.getElementById('survey-cancel');
const leaderboardPanel = document.getElementById('leaderboard-panel');
const leaderboardList = document.getElementById('leaderboard-list');
const leaderboardRaterCount = document.getElementById('leaderboard-rater-count');
const closeLeaderboard = document.getElementById('close-leaderboard');

leaderboardToggle.addEventListener('click', () => {
  if (!isAdmin) {
    adminModal.classList.remove('hidden');
    adminPasswordInput.value = '';
    adminPasswordInput.focus();
    return;
  }
  checkAndStartSurvey();
});

surveyCancelBtn.addEventListener('click', () => {
  surveyActive = false;
  surveyModal.classList.add('hidden');
});

closeLeaderboard.addEventListener('click', () => {
  leaderboardPanel.classList.add('hidden');
  selectedElement = null;
  leaderboardHighlight = null;
  render();
});

function renderLineScreengrab(highlightLineId) {
  const grabW = 800, grabH = Math.round(grabW * (GRID_HEIGHT_FT / GRID_WIDTH_FT));
  const offscreen = document.createElement('canvas');
  offscreen.width = grabW;
  offscreen.height = grabH;
  const oc = offscreen.getContext('2d');

  const savedCtx = ctx, savedCanvas = canvas;
  const savedBaseScale = baseScale, savedZoom = zoomLevel;
  const savedVCX = viewCenterX, savedVCY = viewCenterY;
  const savedHover = hoveredElement, savedSel = selectedElement;

  canvas = offscreen;
  ctx = oc;
  baseScale = (grabW - 20) / GRID_WIDTH_FT;
  zoomLevel = 1;
  viewCenterX = GRID_WIDTH_FT / 2;
  viewCenterY = GRID_HEIGHT_FT / 2;
  hoveredElement = null;
  selectedElement = null;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, grabW, grabH);

  drawGrid();
  drawLines(lines, { dimExcept: highlightLineId, dimAlpha: 0.12 });
  drawFrames(frames, lines);

  // Draw the highlighted line again on top with extra glow
  const hl = lines.find(l => l.id === highlightLineId);
  if (hl && hl.points.length >= 2) {
    const curve = computeLineCurve(hl.points);
    ctx.save();
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 16;
    ctx.strokeStyle = LED_COLOR;
    ctx.lineWidth = LED_LINE_WIDTH * 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < curve.length; i++) {
      const p = gridToCanvas(curve[i].x, curve[i].y);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.shadowBlur = 4;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.restore();
  }

  const dataUrl = offscreen.toDataURL('image/jpeg', 0.85);

  canvas = savedCanvas;
  ctx = savedCtx;
  baseScale = savedBaseScale;
  zoomLevel = savedZoom;
  viewCenterX = savedVCX;
  viewCenterY = savedVCY;
  hoveredElement = savedHover;
  selectedElement = savedSel;

  return dataUrl;
}

function checkAndStartSurvey() {
  // Ask server which lines this user hasn't rated yet
  fetch('/api/admin/unrated', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'all hail ai', email: currentUser.email })
  })
  .then(r => r.json())
  .then(data => {
    const unratedIds = new Set(data.unrated || []);
    surveyLines = lines.filter(l => l.points.length >= 2 && unratedIds.has(l.id));

    if (surveyLines.length === 0) {
      // All lines rated — go straight to leaderboard
      loadLeaderboard();
      return;
    }

    surveyIndex = 0;
    surveyRatings = [];
    surveyActive = true;
    showSurveyStep();
  })
  .catch(() => showToast('Error checking ratings.'));
}

function showSurveyStep() {
  const line = surveyLines[surveyIndex];
  const imgUrl = renderLineScreengrab(line.id);

  surveyImage.src = imgUrl;
  surveyInfo.textContent = `Line by ${line.authorName}`;
  surveyProgress.textContent = `${surveyIndex + 1} of ${surveyLines.length}`;

  surveyRatingBtns.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const star = document.createElement('span');
    star.className = 'survey-star';
    star.textContent = '\u2606'; // empty star
    star.dataset.value = i;
    star.addEventListener('mouseenter', () => {
      // Fill stars up to this one on hover
      surveyRatingBtns.querySelectorAll('.survey-star').forEach(s => {
        s.textContent = parseInt(s.dataset.value) <= i ? '\u2605' : '\u2606';
      });
    });
    star.addEventListener('mouseleave', () => {
      surveyRatingBtns.querySelectorAll('.survey-star').forEach(s => {
        s.textContent = '\u2606';
      });
    });
    star.addEventListener('click', () => rateLine(i));
    surveyRatingBtns.appendChild(star);
  }

  surveyModal.classList.remove('hidden');
}

function rateLine(score) {
  const line = surveyLines[surveyIndex];
  surveyRatings.push({ lineId: line.id, score });
  surveyIndex++;

  if (surveyIndex >= surveyLines.length) {
    submitSurvey();
  } else {
    showSurveyStep();
  }
}

function submitSurvey() {
  surveyModal.classList.add('hidden');
  surveyActive = false;
  showToast('Submitting ratings...');

  fetch('/api/admin/submit-ratings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'all hail ai', email: currentUser.email, ratings: surveyRatings })
  })
  .then(r => r.json())
  .then(data => {
    if (data.ok) loadLeaderboard();
    else showToast('Error submitting ratings.');
  })
  .catch(() => showToast('Error submitting ratings.'));
}

function loadLeaderboard() {
  fetch('/api/admin/leaderboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'all hail ai' })
  })
  .then(r => r.json())
  .then(data => showLeaderboard(data))
  .catch(() => showToast('Error loading leaderboard.'));
}

function showLeaderboard(data) {
  leaderboardList.innerHTML = '';
  leaderboardRaterCount.textContent = `${data.totalRaters} rater${data.totalRaters !== 1 ? 's' : ''}`;

  for (const entry of data.leaderboard) {
    const div = document.createElement('div');
    div.className = 'leaderboard-item';
    div.dataset.lineid = entry.lineId;
    div.innerHTML = `<span class="leaderboard-rank">#${entry.rank}</span><span class="leaderboard-author">${entry.authorName}</span><span class="leaderboard-score">${entry.averageScore.toFixed(1)} <span class="leaderboard-star">\u2605</span></span><span class="leaderboard-votes">${entry.totalRatings} vote${entry.totalRatings !== 1 ? 's' : ''}</span>`;
    div.addEventListener('click', () => {
      selectedElement = { type: 'line', id: entry.lineId };
      leaderboardHighlight = { lineId: entry.lineId, authorName: entry.authorName };
      leaderboardList.querySelectorAll('.leaderboard-item').forEach(el => el.classList.remove('leaderboard-active'));
      div.classList.add('leaderboard-active');
      render();
    });
    leaderboardList.appendChild(div);
  }

  leaderboardPanel.classList.remove('hidden');
}

// ── Notification Sound ───────────────────────────────────────────────────────

function playNotifSound() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    // Two-tone chime
    [660, 880].forEach((freq, i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, ac.currentTime + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + i * 0.12 + 0.4);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(ac.currentTime + i * 0.12);
      osc.stop(ac.currentTime + i * 0.12 + 0.4);
    });
  } catch (e) {}
}

// ── Admin Panel ──────────────────────────────────────────────────────────────

const adminToggle = document.getElementById('admin-toggle');
const adminModal = document.getElementById('admin-modal');
const adminPasswordInput = document.getElementById('admin-password');
const adminSubmit = document.getElementById('admin-submit');
const adminCancel = document.getElementById('admin-cancel');
const adminPanel = document.getElementById('admin-panel');
const adminUserList = document.getElementById('admin-user-list');
const closeAdmin = document.getElementById('close-admin');

adminToggle.addEventListener('click', () => {
  if (isAdmin) {
    loadAdminUsers();
    adminPanel.classList.toggle('hidden');
  } else {
    adminModal.classList.remove('hidden');
    adminPasswordInput.value = '';
    adminPasswordInput.focus();
  }
});

adminCancel.addEventListener('click', () => adminModal.classList.add('hidden'));
adminPasswordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') adminSubmit.click(); });

adminSubmit.addEventListener('click', () => {
  if (adminPasswordInput.value.trim().toLowerCase() === 'all hail ai') {
    isAdmin = true;
    adminModal.classList.add('hidden');
    adminToggle.style.borderColor = '#cc2222';
    adminToggle.style.color = '#cc2222';
    showToast('Admin mode activated.');
    // Persist admin status on the server for this user
    if (currentUser?.email) {
      fetch('/api/admin/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: 'all hail ai', email: currentUser.email })
      }).catch(() => {});
    }
    loadAdminUsers();
    adminPanel.classList.remove('hidden');
  } else {
    adminPasswordInput.style.borderColor = '#cc2222';
    showToast('Invalid passcode.');
  }
});

closeAdmin.addEventListener('click', () => adminPanel.classList.add('hidden'));

// Event delegation for admin delete buttons
adminUserList.addEventListener('click', (e) => {
  const btn = e.target.closest('.admin-delete-btn');
  if (!btn) return;
  const userId = btn.dataset.userid;
  const userName = btn.dataset.username;
  if (!confirm(`Delete ${userName} and all their lines/frames? This cannot be undone.`)) return;
  fetch('/api/admin/delete-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'all hail ai', userId })
  })
  .then(r => r.json())
  .then(data => {
    if (data.ok) {
      showToast(`${userName} deleted (${data.deleted} elements removed).`);
      loadAdminUsers();
    }
  })
  .catch(() => {});
});

function loadAdminUsers() {
  fetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'all hail ai' })
  })
  .then(r => r.json())
  .then(data => {
    if (!data.users) return;
    adminUserList.innerHTML = '';
    if (data.users.length === 0) {
      adminUserList.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:20px;font-style:italic">No users</p>';
      return;
    }
    for (const u of data.users) {
      const div = document.createElement('div');
      div.className = 'admin-user-item';
      div.innerHTML = `<div class="admin-user-info"><span class="admin-user-name">${u.name}</span><span class="admin-user-email">${u.email}</span></div><div style="display:flex;align-items:center;gap:8px"><span class="admin-user-stats">${u.lines} line${u.lines !== 1 ? 's' : ''}, ${u.frames} frame${u.frames !== 1 ? 's' : ''}</span><button class="admin-delete-btn" data-userid="${u.id}" data-username="${u.name}" title="Delete user and all their elements">&times;</button></div>`;
      adminUserList.appendChild(div);
    }
  })
  .catch(() => {});
}

// ── Toggles ──────────────────────────────────────────────────────────────────

notifToggle.addEventListener('click', () => notifPanel.classList.toggle('hidden'));
closeNotifBtn.addEventListener('click', () => notifPanel.classList.add('hidden'));

// ── Animation Loop ───────────────────────────────────────────────────────────

let needsRender = false;
function requestRender() { needsRender = true; }

function animLoop() {
  requestAnimationFrame(animLoop);
  if (needsRender) {
    needsRender = false;
    render();
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

initLogin();
requestAnimationFrame(animLoop);

})();
