// Remove all Claude bot lines and profiles from the server
const io = require('socket.io-client');
const fs = require('fs');
const SERVER = 'http://209.38.71.208';

async function main() {
  // Load the recorded Claude line IDs
  const claudeLines = JSON.parse(fs.readFileSync('/Users/shaun/github/kierans_projects/line-web/claude-lines.json', 'utf8'));
  console.log(`Loaded ${claudeLines.length} Claude line records\n`);

  // Connect as admin
  const socket = io(SERVER, { transports: ['websocket'] });

  const state = await new Promise((resolve) => {
    socket.on('connect', () => {
      socket.emit('join', { name: 'Cleanup Admin', email: 'cleanup@stress-test.local' });
    });
    socket.on('joined', (data) => resolve(data));
  });

  console.log(`Server state: ${state.state.lines.length} lines, ${state.state.frames.length} frames`);

  // Find all Claude/test lines on the server
  const claudeLineIds = new Set(claudeLines.map(l => l.id));
  const serverClaudeLines = state.state.lines.filter(l =>
    claudeLineIds.has(l.id) || l.authorName.startsWith('Claude') || l.authorName.startsWith('Test') ||
    l.authorName.startsWith('Concurrent') || l.authorName.startsWith('Post-Load')
  );

  console.log(`Found ${serverClaudeLines.length} Claude/test lines to delete\n`);

  // Delete each one (using admin flag)
  let deleted = 0;
  for (const line of serverClaudeLines) {
    socket.emit('delete-own', { id: line.id, type: 'line', admin: true });
    deleted++;
    if (deleted % 20 === 0) {
      console.log(`  Deleted ${deleted}/${serverClaudeLines.length}...`);
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Also delete any Claude/test frames
  const testFrames = state.state.frames.filter(f =>
    f.authorName.startsWith('Claude') || f.authorName.startsWith('Test') ||
    f.authorName.startsWith('Concurrent') || f.authorName.startsWith('Post-Load')
  );
  for (const frame of testFrames) {
    socket.emit('delete-own', { id: frame.id, type: 'frame', admin: true });
    deleted++;
  }

  await new Promise(r => setTimeout(r, 1000));

  // Now delete Claude/test profiles via admin API
  const fetch = globalThis.fetch;
  const profileRes = await fetch(`${SERVER}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'all hail ai' })
  });
  const profileData = await profileRes.json();
  const testProfiles = profileData.users.filter(u =>
    u.email.includes('stress-test.local')
  );

  console.log(`\nDeleting ${testProfiles.length} test profiles...`);
  for (const p of testProfiles) {
    await fetch(`${SERVER}/api/admin/delete-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'all hail ai', userId: p.id })
    });
  }

  // Verify
  await new Promise(r => setTimeout(r, 500));
  socket.disconnect();

  const verifySocket = io(SERVER, { transports: ['websocket'] });
  const finalState = await new Promise((resolve) => {
    verifySocket.on('connect', () => {
      verifySocket.emit('join', { name: 'Verify', email: 'verify@check.local' });
    });
    verifySocket.on('joined', (data) => resolve(data));
  });

  const realLines = finalState.state.lines.filter(l => !l.authorName.startsWith('Claude') && !l.authorName.startsWith('Test') && !l.authorName.startsWith('Verify'));
  const realFrames = finalState.state.frames.filter(f => !f.authorName.startsWith('Claude') && !f.authorName.startsWith('Test') && !f.authorName.startsWith('Verify'));

  console.log(`\n=== CLEANUP COMPLETE ===`);
  console.log(`Remaining lines: ${finalState.state.lines.length} (real users: ${realLines.length})`);
  console.log(`Remaining frames: ${finalState.state.frames.length} (real users: ${realFrames.length})`);
  console.log(`\nReal user elements preserved:`);
  for (const l of realLines) console.log(`  Line: "${l.authorName}" — ${l.points.length} points`);
  for (const f of realFrames) console.log(`  Frame: "${f.authorName}" — ${f.type}`);

  // Clean up the verify profile
  const vRes = await fetch(`${SERVER}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'all hail ai' })
  });
  const vData = await vRes.json();
  const verifyProfile = vData.users.find(u => u.email === 'verify@check.local');
  if (verifyProfile) {
    await fetch(`${SERVER}/api/admin/delete-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'all hail ai', userId: verifyProfile.id })
    });
  }

  verifySocket.disconnect();
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
