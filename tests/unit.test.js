// Unit tests for the pure logic in app.js (run: node --test tests/unit.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../app.js');

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, (msg || '') + ` expected ${expected} ±${tol}, got ${actual}`);

function sine(amplitude, n = 4800, freq = 1000, rate = 48000) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
  return a;
}

test('RMS and dBFS: full-scale sine is -3 dBFS, square is 0, silence is the floor', () => {
  near(Core.rms(sine(1)), Math.SQRT1_2, 1e-3);
  near(Core.rmsToDb(Core.rms(sine(1))), -3.01, 0.02);
  near(Core.powerToDb(Core.meanSquare(new Float32Array(100).fill(1))), 0, 1e-9);
  assert.equal(Core.powerToDb(Core.meanSquare(new Float32Array(100))), Core.SILENCE_DB);
  assert.equal(Core.meanSquare(new Float32Array(0)), 0);
  near(Core.dbToPower(Core.powerToDb(0.0123)), 0.0123, 1e-9);
});

test('calibration: a 0.1 amplitude sine with the default +94 offset reads ~71 dB', () => {
  const dbfs = Core.powerToDb(Core.meanSquare(sine(0.1)));
  near(dbfs + Core.DEFAULT_OFFSET, 71.0, 0.05);
});

test('Smoother: starts at the first value, follows Fast (125 ms) time weighting', () => {
  const s = new Core.Smoother(0.125);
  assert.equal(s.push(1, 0.05), 1);
  // step down to 0: after 125 ms power should be e^-1 of the start
  let p;
  for (let i = 0; i < 5; i++) p = s.push(0, 0.025);
  near(p, Math.exp(-1), 1e-9);
  s.reset();
  assert.equal(s.push(0.5, 0.05), 0.5);
  // a steady signal converges to its own level
  const t = new Core.Smoother();
  t.push(0, 0.05);
  for (let i = 0; i < 40; i++) p = t.push(0.2, 0.05);
  near(p, 0.2, 1e-6);
});

test('Stats: min, max and energy average (Leq)', () => {
  const st = new Core.Stats();
  assert.equal(st.avg, null);
  [60, 70, 80].forEach((v) => st.add(v));
  st.add(NaN); // ignored
  assert.equal(st.min, 60);
  assert.equal(st.max, 80);
  near(st.avg, 75.7, 0.05); // energy average is dominated by the loudest part
  st.reset();
  assert.equal(st.min, null);
  assert.equal(st.count, 0);
});

test('zones: green under 60, yellow 60–80, red over 80', () => {
  assert.equal(Core.zoneOf(30), 'green');
  assert.equal(Core.zoneOf(59.9), 'green');
  assert.equal(Core.zoneOf(60), 'yellow');
  assert.equal(Core.zoneOf(80), 'yellow');
  assert.equal(Core.zoneOf(80.1), 'red');
});

test('window shrinks with level: 3 dB, then 2, then 1', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(Core.windowForLevel), [3, 3, 3, 2, 2, 2, 1, 1, 1]);
});

test('judge: success only within the window just below the target', () => {
  assert.equal(Core.judge(70, 70, 3), 'perfect');
  assert.equal(Core.judge(67, 70, 3), 'perfect');
  assert.equal(Core.judge(68.5, 70, 3), 'perfect');
  assert.equal(Core.judge(70.1, 70, 3), 'loud');
  assert.equal(Core.judge(66.9, 70, 3), 'quiet');
  assert.equal(Core.judge(40, 70, 3), 'quiet');
  assert.equal(Core.judge(95, 70, 3), 'loud');
  // judged at the 0.1 dB precision that is displayed
  assert.equal(Core.judge(70.04, 70, 3), 'perfect');
  assert.equal(Core.judge(70.06, 70, 3), 'loud');
  assert.equal(Core.judge(66.96, 70, 3), 'perfect');
  assert.equal(Core.judge(66.94, 70, 3), 'quiet');
  assert.equal(Core.judge(69.5, 70, 1), 'perfect');
  assert.equal(Core.judge(68.9, 70, 1), 'quiet');
});

test('targets: random 50–85, raised in noisy rooms so the window is detectable', () => {
  assert.deepEqual(Core.targetRange(35, 3), { lo: 50, hi: 85, raised: false });
  assert.deepEqual(Core.targetRange(-Infinity, 3), { lo: 50, hi: 85, raised: false });
  assert.deepEqual(Core.targetRange(60, 3), { lo: 70, hi: 85, raised: true });
  assert.deepEqual(Core.targetRange(95, 1), { lo: 85, hi: 85, raised: true });
  assert.equal(Core.pickTarget(35, 3, () => 0), 50);
  assert.equal(Core.pickTarget(35, 3, () => 0.999999), 85);
  assert.equal(Core.pickTarget(60, 2, () => 0), 69);
  for (let i = 0; i < 2000; i++) {
    const t = Core.pickTarget(40, 3);
    assert.ok(Number.isInteger(t) && t >= 50 && t <= 85, 'target ' + t);
  }
  const seen = new Set();
  for (let i = 0; i < 3000; i++) seen.add(Core.pickTarget(30, 3));
  assert.equal(seen.size, 36, 'every target from 50 to 85 shows up');
});

test('loudest → softest: targets step down from 85 dB at level 1 to 50 dB at level 9', () => {
  const targets = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(Core.descendingTarget);
  assert.deepEqual(targets, [85, 81, 76, 72, 68, 63, 59, 54, 50]);
  for (let i = 1; i < targets.length; i++) assert.ok(targets[i] < targets[i - 1], 'strictly softer each level');
  assert.equal(Core.descendingTarget(0), 85);
  assert.equal(Core.descendingTarget(10), 50);
});

test('targetFor: picks by target order, window by level, and respects room noise', () => {
  assert.deepEqual(Core.targetFor(1, 'descending', 35), { target: 85, win: 3, raised: false });
  assert.deepEqual(Core.targetFor(5, 'descending', 35), { target: 68, win: 2, raised: false });
  assert.deepEqual(Core.targetFor(9, 'descending', 35), { target: 50, win: 1, raised: false });
  // noisy room (60 dB): level 9 needs at least 60 + 6 + 1 + 1 = 68
  assert.deepEqual(Core.targetFor(9, 'descending', 60), { target: 68, win: 1, raised: true });
  assert.deepEqual(Core.targetFor(2, 'descending', 60), { target: 81, win: 3, raised: false });
  assert.deepEqual(Core.targetFor(4, 'random', 35, () => 0), { target: 50, win: 2, raised: false });
  assert.deepEqual(Core.targetFor(7, 'random', 60, () => 0), { target: 68, win: 1, raised: true });
  for (let i = 0; i < 500; i++) {
    const t = Core.targetFor(3, 'random', 40).target;
    assert.ok(t >= 50 && t <= 85);
  }
});

test('median ignores a single spike (e.g. a tap during the silence)', () => {
  assert.equal(Core.median([40, 41, 39, 90, 40]), 40);
  assert.equal(Core.median([1, 2, 3, 4]), 2.5);
  assert.equal(Core.median([]), Core.SILENCE_DB);
});

// Feed the detector frames every 50 ms: segments of [durationMs, rawDb, fastDb?]
function runDetector(floor, segments) {
  const d = new Core.WordDetector(floor);
  let t = 1000;
  for (const [ms, raw, fast] of segments) {
    for (let e = 0; e < ms; e += 50) {
      const r = d.push(t, raw, fast === undefined ? raw : fast);
      t += 50;
      if (r) return { r, t, d };
    }
  }
  return { r: null, t, d };
}

test('WordDetector: finds a word and its peak', () => {
  const { r } = runDetector(40, [[500, 40], [200, 66], [300, 71], [200, 64], [2000, 40]]);
  assert.ok(r && r.heard);
  assert.equal(r.peak, 71);
  assert.equal(r.start, 1500);
  assert.equal(r.end, 2200);
});

test('WordDetector: the peak comes from the smoothed level, detection from the raw one', () => {
  const { r } = runDetector(40, [[400, 40, 40], [300, 75, 72.5], [1000, 40, 45]]);
  assert.equal(r.peak, 72.5);
});

test('WordDetector: ignores the tap (grace period) and single-frame clicks', () => {
  let { r } = runDetector(40, [[200, 90], [6500, 40]]);
  assert.equal(r.heard, false, 'loud during grace period is ignored');
  ({ r } = runDetector(40, [[500, 40], [50, 85], [500, 40], [50, 85], [6000, 40]]));
  assert.equal(r.heard, false, 'one-frame clicks never start a word');
});

test('WordDetector: short gaps between syllables do not end the word', () => {
  const { r } = runDetector(40, [[400, 40], [250, 68], [300, 41], [250, 73], [1000, 40]]);
  assert.ok(r.heard);
  assert.equal(r.peak, 73);
});

test('WordDetector: nothing heard → gives up after the timeout', () => {
  const { r, t } = runDetector(40, [[10000, 43]]);
  assert.equal(r.heard, false);
  assert.ok(t - 1000 >= Core.VAD.noSpeechMs && t - 1000 <= Core.VAD.noSpeechMs + 100);
  assert.equal(r.peak, 43);
});

test('WordDetector: endless noise is capped', () => {
  const { r, t } = runDetector(40, [[400, 40], [10000, 70]]);
  assert.ok(r.heard);
  assert.ok(t - 1400 <= Core.VAD.maxSpeechMs + 100);
});

test('WordDetector: hysteresis — speech continues while above floor + offMargin', () => {
  // 45 dB is above the off threshold (44) so the word goes on until it drops below
  const { r } = runDetector(40, [[400, 40], [200, 60], [600, 45], [1000, 40]]);
  assert.ok(r.heard);
  assert.equal(r.end, 1400 + 200 + 600);
});

test('newGame: 2–10 players, default and cleaned names', () => {
  const g = Core.newGame(3, ['  Ann  ', '', 'A very very long name here']);
  assert.deepEqual(g.players.map((p) => p.name), ['Ann', 'Player 2', 'A very very long']);
  assert.ok(g.players.every((p) => p.level === 1));
  assert.equal(g.turn, 0);
  assert.equal(g.winner, null);
  assert.equal(Core.newGame(1).players.length, 2);
  assert.equal(Core.newGame(15).players.length, 10);
});

test('applyOutcome: success levels up, a miss resets that player, turns rotate', () => {
  const g = Core.newGame(3);
  let c = Core.applyOutcome(g, 'perfect', false);
  assert.deepEqual(c, { index: 0, before: 1, after: 2, reset: 'none', won: false });
  assert.equal(g.turn, 1);
  Core.applyOutcome(g, 'perfect', false); // P2 -> 2
  Core.applyOutcome(g, 'perfect', false); // P3 -> 2
  assert.equal(g.turn, 0);
  assert.equal(g.round, 2);
  c = Core.applyOutcome(g, 'loud', false); // P1 back to 1
  assert.equal(c.reset, 'player');
  assert.deepEqual(g.players.map((p) => p.level), [1, 2, 2]);
  c = Core.applyOutcome(g, 'quiet', false);
  assert.deepEqual(g.players.map((p) => p.level), [1, 1, 2]);
});

test('applyOutcome: team mode resets everybody', () => {
  const g = Core.newGame(3);
  g.players[0].level = 5;
  g.players[1].level = 4;
  g.players[2].level = 6;
  g.turn = 1;
  const c = Core.applyOutcome(g, 'loud', true);
  assert.equal(c.reset, 'team');
  assert.deepEqual(g.players.map((p) => p.level), [1, 1, 1]);
  assert.equal(g.turn, 2);
});

test('applyOutcome: reaching level 10 wins and ends the game', () => {
  const g = Core.newGame(2);
  g.players[1].level = 9;
  g.turn = 1;
  const c = Core.applyOutcome(g, 'perfect', false);
  assert.equal(c.won, true);
  assert.equal(g.winner, 1);
  assert.equal(g.players[1].level, 10);
  assert.equal(g.turn, 1, 'turn does not advance after a win');
});

test('word list: 100 unique, short, single words', () => {
  assert.equal(Core.WORDS.length, 100);
  assert.equal(new Set(Core.WORDS.map((w) => w.toLowerCase())).size, 100);
  for (const w of Core.WORDS) assert.match(w, /^[A-Z][a-z]{2,11}$/, w);
});

test('drawWord: no repeats until all 100 words are used', () => {
  const g = Core.newGame(2);
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(Core.drawWord(g));
  assert.equal(seen.size, 100);
  assert.ok(Core.WORDS.includes(Core.drawWord(g)), 'bag refills');
  assert.equal(g.bag.length, 99);
});

test('sanitizeSettings: defaults, clamping, bad types', () => {
  const d = { offset: 94, teamMode: false, targetOrder: 'random' };
  assert.deepEqual(Core.sanitizeSettings(null), d);
  assert.deepEqual(Core.sanitizeSettings({ offset: 101.5, teamMode: true, targetOrder: 'descending' }), { offset: 101.5, teamMode: true, targetOrder: 'descending' });
  assert.deepEqual(Core.sanitizeSettings({ offset: 999 }), { ...d, offset: 140 });
  assert.deepEqual(Core.sanitizeSettings({ offset: -5 }), { ...d, offset: 40 });
  assert.deepEqual(Core.sanitizeSettings({ offset: '100', teamMode: 'yes', targetOrder: 'sideways' }), d);
  assert.deepEqual(Core.sanitizeSettings({ offset: NaN }), d);
});

test('sanitizeGame: accepts a valid save, rejects anything broken', () => {
  const good = { v: 1, players: [{ name: 'Ann', level: 4 }, { name: 'Bob', level: 1 }], turn: 1, round: 3, winner: null, bag: [1, 2, 500, 'x'] };
  assert.deepEqual(Core.sanitizeGame(good), { v: 1, players: good.players, turn: 1, round: 3, winner: null, bag: [1, 2] });
  assert.equal(Core.sanitizeGame(null), null);
  assert.equal(Core.sanitizeGame({ players: [{ name: 'A', level: 1 }] }), null);
  assert.equal(Core.sanitizeGame({ ...good, turn: 2 }), null);
  assert.equal(Core.sanitizeGame({ ...good, players: [{ name: 'A', level: 0 }, { name: 'B', level: 1 }] }), null);
  assert.equal(Core.sanitizeGame({ ...good, players: [{ name: 'A', level: 2.5 }, { name: 'B', level: 1 }] }), null);
  assert.equal(Core.sanitizeGame({ ...good, winner: 7 }), null);
  assert.equal(Core.sanitizeGame({ ...good, winner: 0 }).winner, 0);
});
