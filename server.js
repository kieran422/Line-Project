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

// Active sessions: socketId → profileId
const sessions = new Map();

// Load persisted state
const savedState = loadJSON(STATE_FILE, { lines: [], frames: [], deleteRequests: [], snapshots: [], totalElements: 0 });

const lines = new Map();
for (const l of savedState.lines) lines.set(l.id, l);

const frames = new Map();
for (const f of savedState.frames) frames.set(f.id, f);

const deleteRequests = new Map();
for (const r of savedState.deleteRequests) deleteRequests.set(r.id, r);

const snapshots = savedState.snapshots || [];
let totalElements = savedState.totalElements || 0;
let lastEditorId = savedState.lastEditorId || null;
let lastEditorName = savedState.lastEditorName || null;

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

function saveState() {
  saveJSON(STATE_FILE, {
    lines: Array.from(lines.values()),
    frames: Array.from(frames.values()),
    deleteRequests: Array.from(deleteRequests.values()),
    snapshots,
    totalElements,
    lastEditorId,
    lastEditorName
  });
}

function getFullState() {
  return {
    lines: Array.from(lines.values()),
    frames: Array.from(frames.values()),
    deleteRequests: Array.from(deleteRequests.values()),
    snapshots,
    totalElements,
    lastEditorId,
    lastEditorName
  };
}

// Snapshot on editor handoff: when a new user edits, capture previous user's work
function onEdit(profileId, profileName) {
  if (lastEditorId && lastEditorId !== profileId) {
    // Editor changed — snapshot the state as left by the previous editor
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

    // Map this socket to the profile
    sessions.set(socket.id, profile.id);

    // Send the user their profile info + full state
    socket.emit('joined', {
      user: { id: profile.id, name: profile.name, email: profile.email, color: profile.color },
      state: getFullState()
    });
    io.emit('user-joined', { id: profile.id, name: profile.name });
    console.log(`User joined: ${profile.name} (${profile.email})`);
  });

  socket.on('place-line', (data) => {
    const profileId = sessions.get(socket.id);
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
    const profileId = sessions.get(socket.id);
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

    const profileId = sessions.get(socket.id);
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

    const profileId = sessions.get(socket.id);
    const profile = Array.from(profiles.values()).find(p => p.id === profileId);
    if (profile) onEdit(profile.id, profile.name);

    frame.x = data.x;
    frame.y = data.y;
    saveState();
    socket.broadcast.emit('frame-updated', frame);
  });

  socket.on('notify-edit', (data) => {
    const profileId = sessions.get(socket.id);
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
    const profileId = sessions.get(socket.id);
    if (!profileId) return;
    const profile = Array.from(profiles.values()).find(p => p.id === profileId);

    // Snapshot before this user's edit is applied
    if (profile) onEdit(profile.id, profile.name);

    const isAdminUser = data.admin === true;
    if (data.type === 'line') {
      const line = lines.get(data.id);
      if (line && (line.authorId === profileId || isAdminUser)) {
        lines.delete(data.id);
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
    const profileId = sessions.get(socket.id);
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
    const request = deleteRequests.get(data.requestId);
    if (!request) return;

    const profileId = sessions.get(socket.id);
    if (!profileId) return;
    if (request.elementAuthorId !== profileId) return;

    request.status = 'approved';
    if (request.elementType === 'line') lines.delete(request.elementId);
    else frames.delete(request.elementId);

    saveState();
    io.emit('delete-approved', {
      requestId: request.id,
      elementId: request.elementId,
      elementType: request.elementType
    });
  });

  socket.on('deny-delete', (data) => {
    const request = deleteRequests.get(data.requestId);
    if (!request) return;

    const profileId = sessions.get(socket.id);
    if (!profileId) return;
    if (request.elementAuthorId !== profileId) return;

    request.status = 'denied';
    saveState();
    io.emit('delete-denied', { requestId: request.id });
  });

  socket.on('disconnect', () => {
    const profileId = sessions.get(socket.id);
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
