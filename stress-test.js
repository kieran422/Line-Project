// Stress test: create 100 lines from different "Claude Bot" users
// Each line gets random attachment points across the 40x8 grid

const io = require('socket.io-client');

const SERVER = 'http://209.38.71.208';
const TOTAL_LINES = 100;
const GRID_W = 40;
const GRID_H = 8;

const placedLines = []; // track what we placed for later cleanup
let completed = 0;
let errors = 0;

function rand(min, max) { return min + Math.random() * (max - min); }

function generateLine() {
  // Random start point
  const startX = rand(0.5, GRID_W - 0.5);
  const startY = rand(0.5, GRID_H - 0.5);

  // Generate 3-6 attachment points, each within ~3-4 ft of the previous
  const numPts = 3 + Math.floor(Math.random() * 4);
  const points = [{ x: startX, y: startY }];

  for (let i = 1; i < numPts; i++) {
    const prev = points[i - 1];
    const dx = rand(1, 4) * (Math.random() > 0.5 ? 1 : -1);
    const dy = rand(-1.5, 1.5);
    points.push({
      x: Math.max(0.2, Math.min(GRID_W - 0.2, prev.x + dx)),
      y: Math.max(0.2, Math.min(GRID_H - 0.2, prev.y + dy))
    });
  }
  return points;
}

function runBot(index) {
  return new Promise((resolve) => {
    const name = `Claude Bot ${index + 1}`;
    const email = `claude-bot-${index + 1}@stress-test.local`;

    const socket = io(SERVER, { transports: ['websocket'] });

    const timeout = setTimeout(() => {
      console.log(`[${index + 1}] TIMEOUT — no response`);
      errors++;
      socket.disconnect();
      resolve();
    }, 15000);

    socket.on('connect_error', (err) => {
      console.log(`[${index + 1}] CONNECTION ERROR: ${err.message}`);
      errors++;
      clearTimeout(timeout);
      resolve();
    });

    socket.on('connect', () => {
      socket.emit('join', { name, email });
    });

    socket.on('joined', (data) => {
      const points = generateLine();

      socket.emit('place-line', { points });

      // Wait for confirmation
      socket.on('line-placed', (line) => {
        if (line.authorName === name) {
          placedLines.push({ id: line.id, authorName: name, email, pointCount: points.length });
          completed++;
          clearTimeout(timeout);

          if (completed % 10 === 0) {
            console.log(`Progress: ${completed}/${TOTAL_LINES} placed, ${errors} errors`);
          }

          socket.disconnect();
          resolve();
        }
      });
    });
  });
}

async function main() {
  console.log(`\nStress Test: Placing ${TOTAL_LINES} lines on ${SERVER}\n`);
  console.log('--- Getting current state first ---');

  // First, check existing state
  const checkSocket = io(SERVER, { transports: ['websocket'] });

  await new Promise((resolve) => {
    checkSocket.on('connect', () => {
      checkSocket.emit('join', { name: 'Claude Inspector', email: 'claude-inspector@stress-test.local' });
    });

    checkSocket.on('joined', (data) => {
      const realUsers = data.state.lines.filter(l => !l.authorName.startsWith('Claude'));
      const realFrames = data.state.frames.filter(f => !f.authorName.startsWith('Claude'));

      console.log(`\nExisting REAL user lines: ${realUsers.length}`);
      for (const l of realUsers) {
        console.log(`  - "${l.authorName}" (${l.id}) — ${l.points.length} points`);
      }
      console.log(`Existing REAL user frames: ${realFrames.length}`);
      for (const f of realFrames) {
        console.log(`  - "${f.authorName}" (${f.id}) — ${f.type}`);
      }
      console.log('');

      checkSocket.disconnect();
      resolve();
    });
  });

  // Run bots in batches of 10
  const batchSize = 10;
  for (let b = 0; b < TOTAL_LINES; b += batchSize) {
    const batch = [];
    for (let i = b; i < Math.min(b + batchSize, TOTAL_LINES); i++) {
      batch.push(runBot(i));
    }
    await Promise.all(batch);

    // Small delay between batches
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n=== STRESS TEST COMPLETE ===`);
  console.log(`Lines placed: ${completed}/${TOTAL_LINES}`);
  console.log(`Errors: ${errors}`);
  console.log(`\nClaude-placed line IDs (for cleanup):`);

  // Save the list
  const fs = require('fs');
  fs.writeFileSync('/Users/shaun/github/kierans_projects/line-web/claude-lines.json',
    JSON.stringify(placedLines, null, 2));
  console.log(`Saved ${placedLines.length} line records to claude-lines.json`);

  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
