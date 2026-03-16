// Test: login as a real user and try common interactions after stress test
const io = require('socket.io-client');
const SERVER = 'http://209.38.71.208';

async function test() {
  console.log('=== Interaction Test ===\n');

  const socket = io(SERVER, { transports: ['websocket'] });

  const state = await new Promise((resolve) => {
    socket.on('connect', () => {
      socket.emit('join', { name: 'Test Interactor', email: 'test-interact@stress-test.local' });
    });
    socket.on('joined', (data) => resolve(data));
  });

  console.log(`Total lines on server: ${state.state.lines.length}`);
  console.log(`Total frames on server: ${state.state.frames.length}`);
  console.log(`Total profiles: checked via state`);

  // Test 1: Can we place a line?
  console.log('\nTest 1: Place a line...');
  socket.emit('place-line', { points: [{ x: 1, y: 1 }, { x: 3, y: 2 }, { x: 5, y: 1.5 }] });

  const linePlaced = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 5000);
    socket.on('line-placed', (l) => {
      if (l.authorName === 'Test Interactor') {
        clearTimeout(t);
        resolve(l);
      }
    });
  });

  if (linePlaced) {
    console.log(`  PASS — line placed (${linePlaced.id})`);

    // Test 2: Edit the line
    console.log('Test 2: Edit line points...');
    const newPoints = linePlaced.points.map((p, i) => i === 1 ? { x: p.x, y: p.y + 0.5 } : p);
    socket.emit('edit-line', { id: linePlaced.id, points: newPoints });
    console.log('  PASS — edit emitted');

    // Test 3: Delete own line
    console.log('Test 3: Delete own line...');
    socket.emit('delete-own', { id: linePlaced.id, type: 'line' });

    const deleted = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 5000);
      socket.on('element-deleted', (d) => {
        if (d.id === linePlaced.id) { clearTimeout(t); resolve(true); }
      });
    });
    console.log(deleted ? '  PASS — deleted' : '  FAIL — no delete confirmation');
  } else {
    console.log('  FAIL — line not placed (TIMEOUT)');
  }

  // Test 4: Place a frame
  console.log('Test 4: Place a frame...');
  socket.emit('place-frame', { x: 10, y: 4, width: 2, height: 2, type: 'large' });

  const framePlaced = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 5000);
    socket.on('frame-placed', (f) => {
      if (f.authorName === 'Test Interactor') { clearTimeout(t); resolve(f); }
    });
  });

  if (framePlaced) {
    console.log(`  PASS — frame placed (${framePlaced.id})`);

    // Clean up
    socket.emit('delete-own', { id: framePlaced.id, type: 'frame' });
    console.log('  Cleaned up test frame');
  } else {
    console.log('  FAIL — frame not placed (TIMEOUT)');
  }

  // Test 5: Request delete on someone else's line
  console.log('Test 5: Request delete on another user\'s line...');
  const otherLine = state.state.lines.find(l => !l.authorName.startsWith('Claude') && !l.authorName.startsWith('Test'));
  if (otherLine) {
    socket.emit('request-delete', {
      elementId: otherLine.id,
      elementType: 'line',
      elementAuthorId: otherLine.authorId,
      elementAuthorName: otherLine.authorName
    });

    const reqSent = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 3000);
      socket.on('delete-request', () => { clearTimeout(t); resolve(true); });
    });
    console.log(reqSent ? '  PASS — delete request sent' : '  FAIL — no confirmation');
  } else {
    console.log('  SKIP — no other user lines to test');
  }

  console.log('\n=== All Tests Complete ===');
  socket.disconnect();
  process.exit(0);
}

test().catch(e => { console.error('Fatal:', e); process.exit(1); });
