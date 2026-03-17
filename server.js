const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static('public'));
app.use(express.json());

// Lookup endpoint — returns stored name for an email (if exists)
app.post('/api/lookup', (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email) return res.json({ found: false });
  const profile = profiles.get(email);
  if (profile) return res.json({ found: true, name: profile.name });
  return res.json({ found: false });
});

// Grant admin to a user by email (requires passcode)
app.post('/api/admin/grant', (req, res) => {
  if (req.body.passcode !== 'all hail ai') return res.status(403).json({ error: 'invalid' });
  const email = (req.body.email || '').toLowerCase().trim();
  const profile = profiles.get(email);
  if (!profile) return res.status(404).json({ error: 'user not found' });
  profile.isAdmin = true;
  saveProfiles();
  return res.json({ ok: true });
});

// Admin endpoint — returns all users (requires passcode)
app.post('/api/admin/users', (req, res) => {
  if (req.body.passcode !== 'all hail ai') return res.status(403).json({ error: 'invalid' });
  const users = Array.from(profiles.values()).map(p => {
    const userLines = Array.from(lines.values()).filter(l => l.authorId === p.id).length;
    const userFrames = Array.from(frames.values()).filter(f => f.authorId === p.id).length;
    return { id: p.id, name: p.name, email: p.email, lines: userLines, frames: userFrames };
  });
  return res.json({ users });
});

// Admin delete user — removes profile and all owned elements
app.post('/api/admin/delete-user', (req, res) => {
  if (req.body.passcode !== 'all hail ai') return res.status(403).json({ error: 'invalid' });
  const userId = req.body.userId;
  if (!userId) return res.status(400).json({ error: 'missing userId' });

  // Find and remove the profile
  let removed = false;
  for (const [email, profile] of profiles.entries()) {
    if (profile.id === userId) {
      profiles.delete(email);
      removed = true;
      break;
    }
  }
  if (!removed) return res.status(404).json({ error: 'user not found' });

  // Delete all lines owned by this user
  const deletedIds = [];
  for (const [id, line] of lines.entries()) {
    if (line.authorId === userId) {
      lines.delete(id);
      deletedIds.push({ id, type: 'line' });
    }
  }

  // Delete all frames owned by this user
  for (const [id, frame] of frames.entries()) {
    if (frame.authorId === userId) {
      frames.delete(id);
      deletedIds.push({ id, type: 'frame' });
    }
  }

  // Delete pending delete requests from/about this user
  for (const [id, req] of deleteRequests.entries()) {
    if (req.requesterId === userId || req.elementAuthorId === userId) {
      deleteRequests.delete(id);
    }
  }

  saveProfiles();
  saveState();

  // Broadcast deletions to all connected clients
  for (const d of deletedIds) {
    io.emit('element-deleted', d);
  }

  return res.json({ ok: true, deleted: deletedIds.length });
});

// Submit survey ratings
// Projects list API
app.post('/api/projects', (req, res) => {
  const result = PROJECT_LIST.map(p => {
    const proj = projects.get(p.id);
    return {
      id: p.id,
      name: p.name,
      lineCount: proj ? proj.lines.size : 0,
      frameCount: proj ? proj.frames.size : 0
    };
  });
  return res.json({ projects: result });
});

app.post('/api/ratings/submit', (req, res) => {
  const projectId = req.body.projectId || 'collaborative-student';
  const proj = projects.get(projectId);
  if (!proj) return res.status(404).json({ error: 'project not found' });
  bindProject(proj);
  const email = (req.body.email || '').toLowerCase().trim();
  const profile = profiles.get(email);
  if (!profile) return res.status(404).json({ error: 'user not found' });

  const submittedRatings = req.body.ratings || [];
  for (const r of submittedRatings) {
    const line = lines.get(r.lineId);
    if (!line) continue;
    const key = profile.id + ':' + r.lineId;
    ratings.set(key, {
      raterId: profile.id,
      raterName: profile.name,
      lineId: r.lineId,
      lineAuthorId: line.authorId,
      lineAuthorName: line.authorName,
      score: Math.max(1, Math.min(10, Math.round(r.score))),
      timestamp: Date.now()
    });
  }
  saveState();
  return res.json({ ok: true });
});

// Get unrated lines for a user
app.post('/api/ratings/unrated', (req, res) => {
  const projectId = req.body.projectId || 'collaborative-student';
  const proj = projects.get(projectId);
  if (!proj) return res.status(404).json({ error: 'project not found' });
  bindProject(proj);
  const email = (req.body.email || '').toLowerCase().trim();
  const profile = profiles.get(email);
  if (!profile) return res.status(404).json({ error: 'user not found' });

  const unrated = [];
  for (const [id, line] of lines.entries()) {
    if (line.points.length < 2) continue;
    const key = profile.id + ':' + id;
    if (!ratings.has(key)) unrated.push(id);
  }
  return res.json({ unrated });
});

// Get leaderboard
app.post('/api/ratings/leaderboard', (req, res) => {
  const projectId = req.body.projectId || 'collaborative-student';
  const proj = projects.get(projectId);
  if (!proj) return res.status(404).json({ error: 'project not found' });
  bindProject(proj);

  // Aggregate ratings per line
  const lineScores = new Map(); // lineId → { scores: [], authorName, authorId }
  for (const r of ratings.values()) {
    if (!lines.has(r.lineId)) continue;
    if (!lineScores.has(r.lineId)) {
      lineScores.set(r.lineId, { scores: [], votes: [], authorName: r.lineAuthorName, authorId: r.lineAuthorId });
    }
    lineScores.get(r.lineId).scores.push(r.score);
    lineScores.get(r.lineId).votes.push({ raterName: r.raterName, score: r.score });
  }

  // Compute averages and rank
  const leaderboard = [];
  for (const [lineId, data] of lineScores.entries()) {
    const avg = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
    leaderboard.push({
      lineId,
      authorName: data.authorName,
      authorId: data.authorId,
      averageScore: avg,
      totalRatings: data.scores.length,
      votes: data.votes
    });
  }
  leaderboard.sort((a, b) => b.averageScore - a.averageScore);
  leaderboard.forEach((e, i) => e.rank = i + 1);

  // Count unique raters
  const raterIds = new Set();
  for (const r of ratings.values()) raterIds.add(r.raterId);

  return res.json({ leaderboard, totalRaters: raterIds.size });
});

// AI Composition Generator (Ai Test project only)
app.post('/api/ai-generate', (req, res) => {
  const projectId = req.body.projectId;
  if (projectId !== 'ai-test') return res.status(400).json({ error: 'AI generation only available for Ai Test project' });

  const proj = projects.get('ai-test');
  if (!proj) return res.status(404).json({ error: 'project not found' });

  // Clear existing AI lines
  for (const [id, line] of proj.lines.entries()) {
    if (line.authorName.startsWith('AI Composer')) proj.lines.delete(id);
  }
  for (const [id, frame] of proj.frames.entries()) {
    if (frame.authorName.startsWith('AI Composer')) proj.frames.delete(id);
  }

  const W = 40, H = 8;
  const generated = { lines: [], frames: [] };

  function r(a, b) { return a + Math.random() * (b - a); }
  function c(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function pt(x, y) { return { x: c(x, 0.4, W - 0.4), y: c(y, 0.4, H - 0.4) }; }

  // Composition anchors — 3 focal zones across the 40ft span
  const zoneL = { x: r(6, 10), y: r(2.5, 5.5) };
  const zoneC = { x: r(18, 22), y: r(2.5, 5.5) };
  const zoneR = { x: r(30, 34), y: r(2.5, 5.5) };
  const zones = [zoneL, zoneC, zoneR];

  const allLines = [];

  // ═══ 1. ART DECO MEDALLIONS — 3 intricate looping shapes, one per zone (9 lines) ═══
  // Each medallion is 3 lines that together form an ornate shape
  for (let z = 0; z < 3; z++) {
    const cx = zones[z].x, cy = zones[z].y;
    const size = r(2.5, 3.5);

    // Line A: outer ornate loop — many points tracing an elongated figure-8
    const ptsA = [];
    for (let t = 0; t <= 1; t += 0.04) {
      const angle = t * Math.PI * 2;
      const lobeX = Math.sin(angle) * size * (1 + 0.3 * Math.sin(angle * 3));
      const lobeY = Math.sin(angle * 2) * size * 0.45 * (1 + 0.2 * Math.cos(angle * 5));
      ptsA.push(pt(cx + lobeX, cy + lobeY));
    }
    // Sample down to ~15 points for the LED strip
    const sampledA = [];
    for (let i = 0; i < 15; i++) {
      sampledA.push(ptsA[Math.floor(i * ptsA.length / 15)]);
    }
    allLines.push(sampledA);

    // Line B: inner teardrop/leaf shape — complementary, nested inside
    const ptsB = [];
    const bSize = size * 0.55;
    const bPhase = r(0.3, 0.8);
    for (let i = 0; i < 12; i++) {
      const t = i / 12;
      const angle = t * Math.PI * 2 + bPhase;
      const rr = bSize * (0.7 + 0.3 * Math.cos(angle * 2));
      ptsB.push(pt(cx + Math.cos(angle) * rr, cy + Math.sin(angle) * rr * 0.5));
    }
    allLines.push(ptsB);

    // Line C: accent flourish — a spiral tail extending from the medallion
    const ptsC = [];
    const tailAngle = r(0, Math.PI * 2);
    for (let i = 0; i < 10; i++) {
      const t = i / 10;
      const spiral = tailAngle + t * Math.PI * 1.8;
      const dist = size * 0.3 + t * size * 1.5;
      ptsC.push(pt(cx + Math.cos(spiral) * dist, cy + Math.sin(spiral) * dist * 0.4));
    }
    allLines.push(ptsC);
  }

  // ═══ 2. CONNECTING RIBBONS — 4 lines that weave between the 3 medallions ═══
  // These create visual flow and unity across the composition
  for (let i = 0; i < 4; i++) {
    const pts = [];
    const yOff = (i - 1.5) * 1.2;
    const waviness = r(0.8, 1.8);
    // Trace from left zone through center to right with elegant curves
    for (let j = 0; j < 14; j++) {
      const t = j / 13;
      const x = zones[0].x - 3 + t * (zones[2].x - zones[0].x + 6);
      // Wave that peaks near each zone center
      const nearZone = Math.min(
        Math.abs(x - zones[0].x),
        Math.abs(x - zones[1].x),
        Math.abs(x - zones[2].x)
      );
      const attraction = Math.exp(-nearZone * 0.3) * waviness;
      const baseY = H / 2 + yOff + Math.sin(t * Math.PI * 2.5 + i * 0.7) * (1.5 + attraction);
      pts.push(pt(x, baseY));
    }
    allLines.push(pts);
  }

  // ═══ 3. PARALLEL PAIR LINES — 6 lines (3 pairs) that run close together ═══
  // Art deco double-line motif — two lines suggesting a single elegant band
  for (let p = 0; p < 3; p++) {
    const startX = r(p * 12, p * 12 + 4);
    const endX = startX + r(8, 14);
    const baseY = r(1.5, H - 1.5);
    const gap = r(0.3, 0.6);
    const curvature = r(0.8, 2.0) * (Math.random() > 0.5 ? 1 : -1);

    for (let d = 0; d < 2; d++) {
      const yShift = d === 0 ? -gap / 2 : gap / 2;
      const pts = [];
      for (let j = 0; j < 10; j++) {
        const t = j / 9;
        const x = startX + t * (endX - startX);
        const curve = Math.sin(t * Math.PI) * curvature;
        const taper = Math.sin(t * Math.PI) * gap * 0.5; // lines converge at ends
        pts.push(pt(c(x, 0.4, W - 0.4), baseY + yShift * (1 - taper * 0.3) + curve));
      }
      allLines.push(pts);
    }
  }

  // ═══ 4. CHEVRON FANS — 4 lines forming V/chevron shapes (art deco signature) ═══
  for (let i = 0; i < 2; i++) {
    const tipX = r(8 + i * 20, 14 + i * 20);
    const tipY = i === 0 ? r(1, 2.5) : r(H - 2.5, H - 1);
    const spread = r(5, 8);
    const dir = i === 0 ? 1 : -1;

    for (let arm = 0; arm < 2; arm++) {
      const pts = [];
      const armAngle = arm === 0 ? -0.4 : 0.4;
      // Start at tip, sweep outward in a curved V
      for (let j = 0; j < 10; j++) {
        const t = j / 9;
        const x = tipX + t * spread * (arm === 0 ? -1 : 1) * 0.7;
        const y = tipY + t * spread * dir * 0.4 + Math.sin(t * Math.PI) * r(0.5, 1.5) * dir;
        pts.push(pt(x, y));
      }
      allLines.push(pts);
    }
  }

  // ═══ 5. SCALLOP EDGES — 4 lines with repeating arc patterns along top/bottom ═══
  // Art deco decorative borders
  for (let i = 0; i < 4; i++) {
    const isTop = i < 2;
    const baseY = isTop ? r(0.5, 1.5) : r(H - 1.5, H - 0.5);
    const startX = i % 2 === 0 ? r(1, 5) : r(20, 25);
    const span = r(12, 18);
    const scallops = 3 + Math.floor(r(0, 3));
    const depth = r(0.8, 2.0) * (isTop ? 1 : -1);
    const pts = [];
    for (let j = 0; j <= scallops * 4; j++) {
      const t = j / (scallops * 4);
      const x = startX + t * span;
      const scallop = Math.abs(Math.sin(t * Math.PI * scallops)) * depth;
      pts.push(pt(c(x, 0.4, W - 0.4), baseY + scallop));
    }
    // Sample to ~12 points
    const sampled = [];
    for (let s = 0; s < 12; s++) {
      sampled.push(pts[Math.floor(s * pts.length / 12)]);
    }
    allLines.push(sampled);
  }

  // ═══ 6. GRAND SWEEPS — 2 long confident lines tying the whole piece together ═══
  for (let i = 0; i < 2; i++) {
    const pts = [];
    const y0 = i === 0 ? r(1, 2.5) : r(H - 2.5, H - 1);
    const yEnd = i === 0 ? r(H - 2.5, H - 1) : r(1, 2.5);
    // Graceful S-curve across the entire width with many control points
    for (let j = 0; j < 16; j++) {
      const t = j / 15;
      const x = 0.5 + t * (W - 1);
      const progress = t * Math.PI;
      const y = y0 + (yEnd - y0) * t + Math.sin(progress * 1.5 + i * 0.5) * r(1, 2.5);
      pts.push(pt(x, y));
    }
    allLines.push(pts);
  }

  // Place all 35 lines
  for (let i = 0; i < allLines.length && i < 35; i++) {
    const line = {
      id: uuidv4(),
      authorId: 'ai-composer-' + i,
      authorName: 'AI Composer ' + (i + 1),
      color: '#fff0d8',
      points: allLines[i]
    };
    proj.lines.set(line.id, line);
    generated.lines.push(line);
  }

  // ═══ FRAMES — placed intentionally at compositional intersections ═══
  // Large frames at the two tension knots (where lines converge = maximum diffusion)
  // Small frames at golden-ratio positions and accent points
  const framePlacements = [
    // Large frames at each medallion center — catches the dense ornate loops
    { x: zones[0].x, y: zones[0].y, w: 2, h: 2, type: 'large' },
    { x: zones[1].x, y: zones[1].y, w: 2, h: 2, type: 'large' },
    { x: zones[2].x, y: zones[2].y, w: 2, h: 2, type: 'large' },
    // Small frames between medallions where ribbons cross
    { x: (zones[0].x + zones[1].x) / 2, y: H / 2 + r(-1, 1), w: 8/12, h: 8/12, type: 'small' },
    { x: (zones[1].x + zones[2].x) / 2, y: H / 2 + r(-1, 1), w: 8/12, h: 8/12, type: 'small' },
    // Small accents near chevron tips
    { x: r(3, 6), y: r(1, 2.5), w: 8/12, h: 8/12, type: 'small' },
    { x: r(34, 38), y: r(5.5, 7), w: 8/12, h: 8/12, type: 'small' },
    // Along scallop edges
    { x: r(8, 15), y: r(0.8, 1.8), w: 8/12, h: 8/12, type: 'small' },
    { x: r(25, 32), y: r(H - 1.8, H - 0.8), w: 8/12, h: 8/12, type: 'small' },
    // Large frame at the visual center between ribbons
    { x: W / 2 + r(-2, 2), y: H / 2 + r(-0.5, 0.5), w: 2, h: 2, type: 'large' },
  ];

  for (let i = 0; i < framePlacements.length; i++) {
    const fp = framePlacements[i];
    const frame = {
      id: uuidv4(),
      authorId: 'ai-composer-frame-' + i,
      authorName: 'AI Composer',
      x: fp.x,
      y: fp.y,
      width: fp.w,
      height: fp.h,
      type: fp.type
    };
    proj.frames.set(frame.id, frame);
    generated.frames.push(frame);
  }

  proj.totalElements = proj.lines.size + proj.frames.size;
  saveProject(proj);

  return res.json({ ok: true, lines: generated.lines.length, frames: generated.frames.length });
});

// ── Persistence ─────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function loadJSON(filepath, fallback) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    }
  } catch (e) {
    console.error(`Error loading ${filepath}:`, e.message);
  }
  return fallback;
}

function saveJSON(filepath, data) {
  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`Error saving ${filepath}:`, e.message);
  }
}

// ── State ──────────────────────────────────────────────────────────────────────
// Profiles: email → { id, email, name, color }
const profiles = new Map();
const loadedProfiles = loadJSON(PROFILES_FILE, []);
for (const p of loadedProfiles) {
  profiles.set(p.email, p);
}

// Active sessions: socketId → { profileId, projectId }
const sessions = new Map();

// ── Multi-Project System ─────────────────────────────────────────────────────
const PROJECT_LIST = [
  { id: 'collaborative-student', name: 'Collaborative Student Project' },
  { id: 'ai-test', name: 'Ai Test' }
];

const projects = new Map(); // projectId → { lines, frames, deleteRequests, ratings, snapshots, totalElements, lastEditorId, lastEditorName }

function loadProject(id) {
  const file = path.join(DATA_DIR, `state-${id}.json`);
  const saved = loadJSON(file, { lines: [], frames: [], deleteRequests: [], snapshots: [], totalElements: 0, ratings: [] });
  const proj = {
    id,
    lines: new Map(),
    frames: new Map(),
    deleteRequests: new Map(),
    ratings: new Map(),
    snapshots: saved.snapshots || [],
    totalElements: saved.totalElements || 0,
    lastEditorId: saved.lastEditorId || null,
    lastEditorName: saved.lastEditorName || null
  };
  for (const l of (saved.lines || [])) proj.lines.set(l.id, l);
  for (const f of (saved.frames || [])) proj.frames.set(f.id, f);
  for (const r of (saved.deleteRequests || [])) proj.deleteRequests.set(r.id, r);
  for (const r of (saved.ratings || [])) proj.ratings.set(r.raterId + ':' + r.lineId, r);
  return proj;
}

function saveProject(proj) {
  const file = path.join(DATA_DIR, `state-${proj.id}.json`);
  saveJSON(file, {
    lines: Array.from(proj.lines.values()),
    frames: Array.from(proj.frames.values()),
    deleteRequests: Array.from(proj.deleteRequests.values()),
    snapshots: proj.snapshots,
    totalElements: proj.totalElements,
    lastEditorId: proj.lastEditorId,
    lastEditorName: proj.lastEditorName,
    ratings: Array.from(proj.ratings.values())
  });
}

// Migrate old state.json to the default project if needed
const oldStateFile = path.join(DATA_DIR, 'state.json');
const defaultProjFile = path.join(DATA_DIR, 'state-collaborative-student.json');
if (fs.existsSync(oldStateFile) && !fs.existsSync(defaultProjFile)) {
  fs.renameSync(oldStateFile, defaultProjFile);
  console.log('Migrated state.json → state-collaborative-student.json');
}

// Load all projects
for (const p of PROJECT_LIST) {
  projects.set(p.id, loadProject(p.id));
}

// Helper to get project for a socket
function getSessionProject(socketId) {
  const sess = sessions.get(socketId);
  if (!sess) return null;
  return projects.get(sess.projectId) || null;
}

// Convenience aliases for backward compat in socket handlers
// These will be set per-handler call
let lines, frames, deleteRequests, ratings, snapshots, totalElements, lastEditorId, lastEditorName;

function bindProject(proj) {
  _boundProject = proj;
  lines = proj.lines;
  frames = proj.frames;
  deleteRequests = proj.deleteRequests;
  ratings = proj.ratings;
  snapshots = proj.snapshots;
  totalElements = proj.totalElements;
  lastEditorId = proj.lastEditorId;
  lastEditorName = proj.lastEditorName;
}

const COLORS = [
  '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be',
  '#30b0c7', '#007aff', '#5856d6', '#af52de', '#ff2d55',
  '#ff6b6b', '#ffa502', '#eccc68', '#7bed9f', '#70a1ff',
  '#5352ed', '#ff4757', '#2ed573', '#1e90ff', '#3742fa',
  '#e056fd', '#686de0', '#ffbe76', '#badc58', '#f9ca24',
  '#6ab04c', '#eb4d4b', '#30336b', '#22a6b3', '#be2edd',
  '#f0932b', '#c56cf0', '#7158e2', '#3dc1d3', '#e15f41',
  '#fad390', '#6a89cc', '#82ccdd', '#b8e994', '#f8c291'
];
let colorIndex = profiles.size;

function getNextColor() {
  const color = COLORS[colorIndex % COLORS.length];
  colorIndex++;
  return color;
}

function saveProfiles() {
  saveJSON(PROFILES_FILE, Array.from(profiles.values()));
}

let _boundProject = null;

function saveState(proj) {
  const p = proj || _boundProject;
  if (!p) return;
  p.totalElements = totalElements;
  p.lastEditorId = lastEditorId;
  p.lastEditorName = lastEditorName;
  saveProject(p);
}

function getFullState(proj) {
  return {
    lines: Array.from(proj.lines.values()),
    frames: Array.from(proj.frames.values()),
    deleteRequests: Array.from(proj.deleteRequests.values()),
    snapshots: proj.snapshots,
    totalElements: proj.totalElements,
    lastEditorId: proj.lastEditorId,
    lastEditorName: proj.lastEditorName
  };
}

// Snapshot on editor handoff
function onEdit(profileId, profileName) {
  const proj = _boundProject;
  if (!proj) return;
  if (lastEditorId && lastEditorId !== profileId) {
    snapshots.push({
      id: snapshots.length,
      editorName: lastEditorName,
      editorId: lastEditorId,
      lines: Array.from(lines.values()).map(l => ({ ...l, points: [...l.points] })),
      frames: Array.from(frames.values()).map(f => ({ ...f })),
      timestamp: Date.now()
    });
    io.emit('snapshot-added', snapshots[snapshots.length - 1]);
  }
  lastEditorId = profileId;
  lastEditorName = profileName;
  proj.lastEditorId = profileId;
  proj.lastEditorName = profileName;
}

function getOrCreateProfile(email, name) {
  const normalized = email.toLowerCase().trim();
  let profile = profiles.get(normalized);

  if (profile) {
    // Returning user — keep their original name, don't update
    return profile;
  }

  // New profile
  profile = {
    id: uuidv4(),
    email: normalized,
    name: name,
    color: getNextColor()
  };
  profiles.set(normalized, profile);
  saveProfiles();
  return profile;
}

// (old maybeSnapshot removed — replaced by onEdit handoff system)

// ── Socket Events ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('join', (data) => {
    const profile = getOrCreateProfile(data.email, data.name);
    const projectId = data.projectId || 'collaborative-student';
    const proj = projects.get(projectId);
    if (!proj) return;

    // Map this socket to the profile and project
    sessions.set(socket.id, { profileId: profile.id, projectId });
    socket.join('project:' + projectId);
    bindProject(proj);

    socket.emit('joined', {
      user: { id: profile.id, name: profile.name, email: profile.email, color: profile.color, isAdmin: profile.isAdmin || false },
      state: getFullState(proj),
      projectId
    });
    io.emit('user-joined', { id: profile.id, name: profile.name });
    console.log(`User joined: ${profile.name} (${profile.email})`);
  });

  socket.on('place-line', (data) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const profileId = sess.profileId;
    const proj = projects.get(sess.projectId);
    if (!proj) return;
    bindProject(proj);
    const profile = Array.from(profiles.values()).find(p => p.id === profileId);
    if (!profile) return;

    // Each user can only place 1 line
    const existingLine = Array.from(lines.values()).find(l => l.authorId === profile.id);
    if (existingLine) return;

    // Snapshot before this user's edit is applied
    onEdit(profile.id, profile.name);

    const line = {
      id: uuidv4(),
      authorId: profile.id,
      authorName: profile.name,
      color: profile.color,
      points: data.points
    };
    lines.set(line.id, line);
    totalElements++;
    saveState();
    io.emit('line-placed', line);
  });

  socket.on('place-frame', (data) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const profileId = sess.profileId;
    const proj = projects.get(sess.projectId);
    if (!proj) return;
    bindProject(proj);
    const profile = Array.from(profiles.values()).find(p => p.id === profileId);
    if (!profile) return;

    // Snapshot before this user's edit is applied
    onEdit(profile.id, profile.name);

    const frame = {
      id: uuidv4(),
      authorId: profile.id,
      authorName: profile.name,
      x: data.x,
      y: data.y,
      width: data.width,
      height: data.height,
      type: data.type
    };
    frames.set(frame.id, frame);
    totalElements++;
    saveState();
    io.emit('frame-placed', frame);
  });

  socket.on('edit-line', (data) => {
    const line = lines.get(data.id);
    if (!line) return;

    const _s = sessions.get(socket.id);
    const profileId = _s?.profileId;
    const _proj = _s ? projects.get(_s.projectId) : null;
    if (_proj) bindProject(_proj);
    const profile = Array.from(profiles.values()).find(p => p.id === profileId);

    // Enforce 20ft max strip length server-side
    const pts = data.points;
    if (pts && pts.length >= 2) {
      let total = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
        total += Math.sqrt(dx * dx + dy * dy);
      }
      if (total > 22) return;
    }

    if (profile) onEdit(profile.id, profile.name);
    line.points = data.points;
    saveState();
    socket.broadcast.emit('line-updated', line);
  });

  socket.on('edit-frame', (data) => {
    const frame = frames.get(data.id);
    if (!frame) return;

    const _s = sessions.get(socket.id);
    const profileId = _s?.profileId;
    const _proj = _s ? projects.get(_s.projectId) : null;
    if (_proj) bindProject(_proj);
    const profile = Array.from(profiles.values()).find(p => p.id === profileId);
    if (profile) onEdit(profile.id, profile.name);

    frame.x = data.x;
    frame.y = data.y;
    saveState();
    socket.broadcast.emit('frame-updated', frame);
  });

  socket.on('notify-edit', (data) => {
    const _s = sessions.get(socket.id);
    const profileId = _s?.profileId;
    const _proj = _s ? projects.get(_s.projectId) : null;
    if (_proj) bindProject(_proj);
    const profile = Array.from(profiles.values()).find(p => p.id === profileId);
    if (!profile || !data.authorId) return;
    if (profile.id === data.authorId) return;

    const notification = {
      id: uuidv4(),
      editorId: profile.id,
      editorName: profile.name,
      lineId: data.lineId,
      authorId: data.authorId,
      message: `${profile.name} is editing your line`,
      timestamp: Date.now()
    };

    // Broadcast to all — clients filter by authorId
    io.emit('line-edited-notification', notification);
    console.log(`Edit notification: ${profile.name} editing ${data.authorName}'s line`);
  });

  socket.on('delete-own', (data) => {
    const _sd = sessions.get(socket.id);
    if (!_sd) return;
    const profileId = _sd.profileId;
    const _projd = projects.get(_sd.projectId);
    if (_projd) bindProject(_projd);
    const profile = Array.from(profiles.values()).find(p => p.id === profileId);

    // Snapshot before this user's edit is applied
    if (profile) onEdit(profile.id, profile.name);

    const isAdminUser = data.admin === true;
    if (data.type === 'line') {
      const line = lines.get(data.id);
      if (line && (line.authorId === profileId || isAdminUser)) {
        lines.delete(data.id);
        // Remove all ratings for this deleted line
        for (const [key, r] of ratings.entries()) {
          if (r.lineId === data.id) ratings.delete(key);
        }
        saveState();
        io.emit('element-deleted', { id: data.id, type: 'line' });
      }
    } else if (data.type === 'frame') {
      const frame = frames.get(data.id);
      if (frame && (frame.authorId === profileId || isAdminUser)) {
        frames.delete(data.id);
        saveState();
        io.emit('element-deleted', { id: data.id, type: 'frame' });
      }
    }
  });

  socket.on('request-delete', (data) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const profileId = sess.profileId;
    const proj = projects.get(sess.projectId);
    if (!proj) return;
    bindProject(proj);
    const profile = Array.from(profiles.values()).find(p => p.id === profileId);
    if (!profile) return;

    const request = {
      id: uuidv4(),
      requesterId: profile.id,
      requesterName: profile.name,
      elementId: data.elementId,
      elementType: data.elementType,
      elementAuthorId: data.elementAuthorId,
      elementAuthorName: data.elementAuthorName,
      status: 'pending'
    };
    deleteRequests.set(request.id, request);
    saveState();
    io.emit('delete-request', request);
  });

  socket.on('approve-delete', (data) => {
    const _sa = sessions.get(socket.id);
    if (!_sa) return;
    const profileId = _sa.profileId;
    const _proja = projects.get(_sa.projectId);
    if (_proja) bindProject(_proja);

    const request = deleteRequests.get(data.requestId);
    if (!request) return;
    if (request.elementAuthorId !== profileId) return;

    request.status = 'approved';
    if (request.elementType === 'line') lines.delete(request.elementId);
    else frames.delete(request.elementId);

    saveState(_proja);
    io.emit('delete-approved', {
      requestId: request.id,
      elementId: request.elementId,
      elementType: request.elementType
    });
  });

  socket.on('deny-delete', (data) => {
    const _sn = sessions.get(socket.id);
    if (!_sn) return;
    const profileId = _sn.profileId;
    const _projn = projects.get(_sn.projectId);
    if (_projn) bindProject(_projn);

    const request = deleteRequests.get(data.requestId);
    if (!request) return;
    if (request.elementAuthorId !== profileId) return;

    request.status = 'denied';
    saveState(_projn);
    io.emit('delete-denied', { requestId: request.id });
  });

  socket.on('disconnect', () => {
    const _sdc = sessions.get(socket.id);
    const profileId = _sdc?.profileId;
    if (profileId) {
      const profile = Array.from(profiles.values()).find(p => p.id === profileId);
      if (profile) {
        console.log(`User disconnected: ${profile.name}`);
        io.emit('user-left', { id: profile.id, name: profile.name });
      }
    }
    sessions.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Collaboration in Line running on http://localhost:${PORT}`);
});
