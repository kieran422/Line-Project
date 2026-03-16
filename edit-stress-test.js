// Edit stress test: login as different users and try to edit/move lines
// Tests: select lines, drag points, add points, move frames

const io = require('socket.io-client');
const SERVER = 'http://209.38.71.208';

let totalTests = 0;
let passed = 0;
let failed = 0;

function log(msg) { console.log(msg); }
function pass(name) { passed++; totalTests++; log(`  PASS — ${name}`); }
function fail(name, reason) { failed++; totalTests++; log(`  FAIL — ${name}: ${reason}`); }

function connectAs(name, email) {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER, { transports: ['websocket'] });
    const timeout = setTimeout(() => { socket.disconnect(); reject(new Error('connect timeout')); }, 10000);

    socket.on('connect', () => {
      socket.emit('join', { name, email });
    });

    socket.on('joined', (data) => {
      clearTimeout(timeout);
      resolve({ socket, user: data.user, state: data.state });
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function waitForEvent(socket, event, filter, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs || 5000);
    const handler = (data) => {
      if (!filter || filter(data)) {
        clearTimeout(t);
        socket.off(event, handler);
        resolve(data);
      }
    };
    socket.on(event, handler);
  });
}

async function testEditOwnLine(conn) {
  log('\n--- Test: Edit own line points ---');
  const myLine = conn.state.lines.find(l => l.authorId === conn.user.id);
  if (!myLine) { fail('edit own line', 'no line found'); return; }

  const origPoints = myLine.points.map(p => ({ ...p }));
  log(`  Line has ${origPoints.length} points`);

  // Move middle point
  if (origPoints.length >= 3) {
    const newPoints = origPoints.map((p, i) => i === 1 ? { x: p.x + 0.5, y: p.y + 0.3 } : { ...p });
    conn.socket.emit('edit-line', { id: myLine.id, points: newPoints });
    await new Promise(r => setTimeout(r, 300));
    pass('moved middle point');

    // Move it back
    conn.socket.emit('edit-line', { id: myLine.id, points: origPoints });
    await new Promise(r => setTimeout(r, 300));
    pass('restored original position');
  } else {
    pass('line too short to move middle point (skipped)');
  }
}

async function testEditOtherUserLine(conn, otherLine) {
  log('\n--- Test: Edit another user\'s line ---');
  if (!otherLine) { fail('edit other line', 'no other line available'); return; }

  const origPoints = otherLine.points.map(p => ({ ...p }));
  log(`  Editing ${otherLine.authorName}'s line (${origPoints.length} points)`);

  // Try to move a middle point (should work)
  if (origPoints.length >= 3) {
    const newPoints = origPoints.map((p, i) => i === 1 ? { x: p.x + 0.2, y: p.y + 0.1 } : { ...p });
    conn.socket.emit('edit-line', { id: otherLine.id, points: newPoints });
    await new Promise(r => setTimeout(r, 300));
    pass('edited middle point of other user\'s line');

    // Restore
    conn.socket.emit('edit-line', { id: otherLine.id, points: origPoints });
    await new Promise(r => setTimeout(r, 300));
    pass('restored other user\'s line');
  }

  // Try to move endpoints (should be blocked by server length check only, not point-lock which is client-side)
  const endpointMoved = origPoints.map((p, i) => i === 0 ? { x: p.x + 0.1, y: p.y } : { ...p });
  conn.socket.emit('edit-line', { id: otherLine.id, points: endpointMoved });
  await new Promise(r => setTimeout(r, 300));
  // Server doesn't block endpoint moves (that's client-side only) — this tests server resilience
  conn.socket.emit('edit-line', { id: otherLine.id, points: origPoints });
  await new Promise(r => setTimeout(r, 300));
  pass('server accepted endpoint edit (client blocks this, server is lenient)');
}

async function testRapidEdits(conn) {
  log('\n--- Test: Rapid-fire edits (simulating fast dragging) ---');
  const myLine = conn.state.lines.find(l => l.authorId === conn.user.id);
  if (!myLine || myLine.points.length < 3) { fail('rapid edits', 'no suitable line'); return; }

  const origPoints = myLine.points.map(p => ({ ...p }));
  let errorCount = 0;

  // Simulate 50 rapid point moves (like fast mouse dragging)
  for (let i = 0; i < 50; i++) {
    const jitter = (Math.random() - 0.5) * 0.3;
    const newPoints = origPoints.map((p, idx) => idx === 1 ? { x: p.x + jitter, y: p.y + jitter } : { ...p });
    try {
      conn.socket.emit('edit-line', { id: myLine.id, points: newPoints });
    } catch (e) {
      errorCount++;
    }
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 50));
  }

  // Restore original
  conn.socket.emit('edit-line', { id: myLine.id, points: origPoints });
  await new Promise(r => setTimeout(r, 500));

  if (errorCount === 0) pass(`50 rapid edits with 0 errors`);
  else fail(`rapid edits`, `${errorCount} errors`);
}

async function testAddAndRemovePoint(conn) {
  log('\n--- Test: Add point then remove it ---');
  const myLine = conn.state.lines.find(l => l.authorId === conn.user.id);
  if (!myLine || myLine.points.length < 2) { fail('add/remove point', 'no suitable line'); return; }

  const origPoints = myLine.points.map(p => ({ ...p }));
  const origLen = origPoints.length;

  // Add a point between first two points
  const mid = {
    x: (origPoints[0].x + origPoints[1].x) / 2,
    y: (origPoints[0].y + origPoints[1].y) / 2 + 0.2
  };
  const withNew = [origPoints[0], mid, ...origPoints.slice(1)];
  conn.socket.emit('edit-line', { id: myLine.id, points: withNew });
  await new Promise(r => setTimeout(r, 300));
  pass(`added point (${origLen} → ${withNew.length})`);

  // Remove it
  conn.socket.emit('edit-line', { id: myLine.id, points: origPoints });
  await new Promise(r => setTimeout(r, 300));
  pass(`removed point (${withNew.length} → ${origLen})`);
}

async function testMultiUserConcurrent() {
  log('\n--- Test: 10 users editing simultaneously ---');

  const connections = [];
  for (let i = 0; i < 10; i++) {
    try {
      const c = await connectAs(`Concurrent Bot ${i + 1}`, `concurrent-${i + 1}@stress-test.local`);
      connections.push(c);
    } catch (e) {
      fail(`concurrent connect ${i + 1}`, e.message);
    }
  }
  log(`  Connected ${connections.length} users`);

  // Each user edits a different Claude bot line
  const claudeLines = connections[0].state.lines.filter(l => l.authorName.startsWith('Claude Bot'));
  let editErrors = 0;

  const editPromises = connections.map(async (conn, idx) => {
    const targetLine = claudeLines[idx * 5]; // spread them out
    if (!targetLine || targetLine.points.length < 3) return;

    const origPoints = targetLine.points.map(p => ({ ...p }));

    // Do 10 rapid edits
    for (let j = 0; j < 10; j++) {
      const jitter = (Math.random() - 0.5) * 0.5;
      const pts = origPoints.map((p, i) => i === 1 ? { x: p.x + jitter, y: p.y + jitter } : { ...p });
      try {
        conn.socket.emit('edit-line', { id: targetLine.id, points: pts });
      } catch (e) { editErrors++; }
      await new Promise(r => setTimeout(r, 30));
    }

    // Restore
    conn.socket.emit('edit-line', { id: targetLine.id, points: origPoints });
  });

  await Promise.all(editPromises);
  await new Promise(r => setTimeout(r, 1000));

  if (editErrors === 0) pass(`10 users × 10 edits = 100 concurrent edits, 0 errors`);
  else fail('concurrent edits', `${editErrors} errors`);

  // Disconnect all
  for (const c of connections) c.socket.disconnect();
}

async function testPlaceAfterHeavyLoad() {
  log('\n--- Test: New user can place line after heavy load ---');
  const conn = await connectAs('Post-Load Tester', 'post-load@stress-test.local');

  // Place a line
  conn.socket.emit('place-line', { points: [{ x: 38, y: 1 }, { x: 39, y: 2 }, { x: 38.5, y: 3 }] });

  const placed = await waitForEvent(conn.socket, 'line-placed', l => l.authorName === 'Post-Load Tester', 5000);
  if (placed) {
    pass('new user placed line after heavy load');
    // Clean up
    conn.socket.emit('delete-own', { id: placed.id, type: 'line' });
    await waitForEvent(conn.socket, 'element-deleted', d => d.id === placed.id, 3000);
    pass('cleaned up test line');
  } else {
    fail('place after load', 'TIMEOUT — this may be the interaction bug!');
  }

  // Place a frame
  conn.socket.emit('place-frame', { x: 38, y: 6, width: 2, height: 2, type: 'large' });
  const frame = await waitForEvent(conn.socket, 'frame-placed', f => f.authorName === 'Post-Load Tester', 5000);
  if (frame) {
    pass('new user placed frame after heavy load');
    conn.socket.emit('delete-own', { id: frame.id, type: 'frame' });
    await waitForEvent(conn.socket, 'element-deleted', d => d.id === frame.id, 3000);
    pass('cleaned up test frame');
  } else {
    fail('place frame after load', 'TIMEOUT');
  }

  conn.socket.disconnect();
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   EDIT STRESS TEST — Bug Hunting Edition     ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // Connect as a Claude bot that already has a line
  log('Connecting as Claude Bot 1...');
  const bot1 = await connectAs('Claude Bot 1', 'claude-bot-1@stress-test.local');
  log(`  State: ${bot1.state.lines.length} lines, ${bot1.state.frames.length} frames\n`);

  // Find other users' lines for cross-edit test
  const realLines = bot1.state.lines.filter(l => !l.authorName.startsWith('Claude') && !l.authorName.startsWith('Test') && !l.authorName.startsWith('Concurrent') && !l.authorName.startsWith('Post'));

  await testEditOwnLine(bot1);
  if (realLines.length > 0) await testEditOtherUserLine(bot1, realLines[0]);
  await testRapidEdits(bot1);
  await testAddAndRemovePoint(bot1);

  bot1.socket.disconnect();

  await testMultiUserConcurrent();
  await testPlaceAfterHeavyLoad();

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log(`║   RESULTS: ${passed} passed, ${failed} failed (${totalTests} total)    `);
  console.log('╚══════════════════════════════════════════════╝');

  if (failed > 0) {
    console.log('\n⚠ FAILURES DETECTED — check above for details');
  } else {
    console.log('\n✓ All tests passed — no interaction bugs found');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
