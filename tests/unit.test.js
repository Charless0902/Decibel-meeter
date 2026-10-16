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

test('calibration: default offset is +105; a 0.1 amplitude sine reads ~82 dB', () => {
  assert.equal(Core.DEFAULT_OFFSET, 105);
  const dbfs = Core.powerToDb(Core.meanSquare(sine(0.1)));
  near(dbfs, -23.0, 0.05);
  near(dbfs + Core.DEFAULT_OFFSET, 82.0, 0.05);
});

test('speechLevel: energy average of the talking, ignoring pauses', () => {
  // talking at -45 dBFS with pauses at -70 -> -45
  const talk = [];
  for (let i = 0; i < 60; i++) talk.push(i % 3 === 0 ? -70 : -45);
  near(Core.speechLevel(talk), -45, 0.01);
  // louder and softer syllables average by energy, like a real meter
  const mixed = [];
  for (let i = 0; i < 60; i++) mixed.push(i % 4 === 0 ? -70 : i % 2 ? -40 : -50);
  const level = Core.speechLevel(mixed);
  assert.ok(level > -45 && level < -40, 'energy average ' + level);
  // no clear talking: steady noise, silence, too few readings
  assert.equal(Core.speechLevel(new Array(60).fill(-60)), null);
  assert.equal(Core.speechLevel(new Array(60).fill(Core.SILENCE_DB)), null);
  assert.equal(Core.speechLevel([-40, -70, -40]), null);
  // a single click in silence is not talking
  const click = new Array(60).fill(-70);
  click[30] = -30;
  assert.equal(Core.speechLevel(click), null);
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

test('window shrinks with level, sized by difficulty (Normal by default)', () => {
  const levels = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(levels.map((l) => Core.windowForLevel(l, 'hard')), [3, 3, 3, 2, 2, 2, 1, 1, 1]);
  assert.deepEqual(levels.map((l) => Core.windowForLevel(l, 'normal')), [5, 5, 5, 4, 4, 4, 3, 3, 3]);
  assert.deepEqual(levels.map((l) => Core.windowForLevel(l, 'easy')), [8, 8, 8, 6, 6, 6, 4, 4, 4]);
  assert.equal(Core.windowForLevel(5), 4, 'normal when unset');
  assert.equal(Core.windowForLevel(5, 'bogus'), 4);
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

test('target ladders: loudest → softest and softest → loudest', () => {
  const levels = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const down = levels.map((l) => Core.plannedTarget(l, 'descending'));
  const up = levels.map((l) => Core.plannedTarget(l, 'ascending'));
  assert.deepEqual(down, [85, 81, 76, 72, 68, 63, 59, 54, 50]);
  assert.deepEqual(up, [50, 54, 59, 63, 68, 72, 76, 81, 85]);
  assert.deepEqual(up, down.slice().reverse(), 'the same ladder, the other way up');
  for (let i = 1; i < 9; i++) {
    assert.ok(down[i] < down[i - 1], 'softer each level');
    assert.ok(up[i] > up[i - 1], 'louder each level');
  }
  assert.equal(Core.plannedTarget(0, 'descending'), 85);
  assert.equal(Core.plannedTarget(10, 'ascending'), 85);
  assert.equal(Core.plannedTarget(3, 'random'), null);
});

test('targetFor: picks by target order, window by level and difficulty, respects room noise', () => {
  const hard = { difficulty: 'hard', floor: 35 };
  assert.deepEqual(Core.targetFor(1, { ...hard, order: 'descending' }), { target: 85, win: 3, raised: false });
  assert.deepEqual(Core.targetFor(5, { ...hard, order: 'descending' }), { target: 68, win: 2, raised: false });
  assert.deepEqual(Core.targetFor(9, { ...hard, order: 'descending' }), { target: 50, win: 1, raised: false });
  assert.deepEqual(Core.targetFor(1, { ...hard, order: 'ascending' }), { target: 50, win: 3, raised: false });
  assert.deepEqual(Core.targetFor(9, { ...hard, order: 'ascending' }), { target: 85, win: 1, raised: false });
  assert.deepEqual(Core.targetFor(1, { order: 'ascending', floor: 35 }), { target: 50, win: 5, raised: false }, 'normal');
  // noisy room (60 dB): the lowest target needs 60 + 6 + window + 1
  assert.deepEqual(Core.targetFor(9, { difficulty: 'hard', order: 'descending', floor: 60 }), { target: 68, win: 1, raised: true });
  assert.deepEqual(Core.targetFor(1, { difficulty: 'normal', order: 'ascending', floor: 60 }), { target: 72, win: 5, raised: true });
  assert.deepEqual(Core.targetFor(2, { difficulty: 'hard', order: 'descending', floor: 60 }), { target: 81, win: 3, raised: false });
  assert.deepEqual(Core.targetFor(4, { order: 'random', floor: 35, rand: () => 0 }), { target: 50, win: 4, raised: false });
  assert.deepEqual(Core.targetFor(7, { difficulty: 'hard', order: 'random', floor: 60, rand: () => 0 }), { target: 68, win: 1, raised: true });
  for (let i = 0; i < 500; i++) {
    const t = Core.targetFor(3, { order: 'random', difficulty: 'easy', floor: 40 }).target;
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

test('drawWord: no repeats until all words are used, never twice in a row', () => {
  const g = Core.newGame(2);
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(Core.drawWord(g));
  assert.equal(seen.size, 100);
  assert.ok(Core.WORDS.includes(Core.drawWord(g)), 'bag refills');
  assert.equal(g.bag.length, 99);

  const mine = ['Pizza party', 'Grandma', 'Taco Tuesday'];
  const h = Core.newGame(2);
  let last = null;
  const counts = {};
  for (let i = 0; i < 300; i++) {
    const w = Core.drawWord(h, mine);
    assert.ok(mine.includes(w), w);
    assert.notEqual(w, last, 'no immediate repeat');
    counts[w] = (counts[w] || 0) + 1;
    last = w;
  }
  assert.deepEqual(Object.values(counts), [100, 100, 100], 'each word equally often');

  // switching lists mid-game drops words that are no longer in the list
  const k = Core.newGame(2);
  Core.drawWord(k);
  assert.ok(mine.includes(Core.drawWord(k, mine)));
});

test('parseWords: one per line or comma separated, trimmed, de-duplicated', () => {
  assert.deepEqual(Core.parseWords('Pizza party\n  Grandma ,taco   tuesday;\n\npizza PARTY\n'), ['Pizza party', 'Grandma', 'taco tuesday']);
  assert.deepEqual(Core.parseWords(''), []);
  assert.deepEqual(Core.parseWords(null), []);
  assert.equal(Core.parseWords('x'.repeat(50))[0].length, Core.CUSTOM_WORDS.maxLength);
  const many = Array.from({ length: 400 }, (_, i) => 'w' + i).join('\n');
  assert.equal(Core.parseWords(many).length, Core.CUSTOM_WORDS.maxWords);
});

test('wordList: built-in, my words, or both (empty "my words" falls back)', () => {
  assert.equal(Core.wordList({ wordSource: 'builtin', customWords: 'A, B' }).length, 100);
  assert.deepEqual(Core.wordList({ wordSource: 'custom', customWords: 'Alpha, Bravo' }), ['Alpha', 'Bravo']);
  assert.equal(Core.wordList({ wordSource: 'custom', customWords: ' , ' }).length, 100, 'fallback');
  const both = Core.wordList({ wordSource: 'both', customWords: 'Alpha\nbanana' });
  assert.equal(both.length, 101, 'banana is already built in');
  assert.ok(both.includes('Alpha') && both.includes('Banana'));
  assert.equal(Core.wordList(undefined).length, 100);
});

test('sanitizeSettings: defaults, clamping, bad types', () => {
  const d = { v: 2, offset: 105, teamMode: false, targetOrder: 'random', difficulty: 'normal', wordSource: 'builtin', customWords: '' };
  assert.deepEqual(Core.sanitizeSettings(null), d);
  const custom = { v: 2, offset: 101.5, teamMode: true, targetOrder: 'ascending', difficulty: 'easy', wordSource: 'both', customWords: 'Hi' };
  assert.deepEqual(Core.sanitizeSettings(custom), custom);
  assert.deepEqual(Core.sanitizeSettings({ v: 2, offset: 999 }), { ...d, offset: 140 });
  assert.deepEqual(Core.sanitizeSettings({ v: 2, offset: -5 }), { ...d, offset: 40 });
  assert.deepEqual(Core.sanitizeSettings({ offset: '100', teamMode: 'yes', targetOrder: 'sideways', difficulty: 'toString', wordSource: 'x', customWords: 5 }), d);
  assert.deepEqual(Core.sanitizeSettings({ offset: NaN }), d);
  assert.equal(Core.sanitizeSettings({ customWords: 'a'.repeat(9000) }).customWords.length, Core.CUSTOM_WORDS.maxText);
});

test('settings from version 1: the old +94 default moves to +105, custom offsets stay', () => {
  assert.deepEqual(Core.sanitizeSettings({ offset: 94, teamMode: true, targetOrder: 'descending' }), {
    v: 2, offset: 105, teamMode: true, targetOrder: 'descending', difficulty: 'normal', wordSource: 'builtin', customWords: '',
  });
  assert.equal(Core.sanitizeSettings({ offset: 99 }).offset, 99, 'a hand-picked offset is kept');
  assert.equal(Core.sanitizeSettings({ v: 2, offset: 94 }).offset, 94, 'version 2 can choose 94 on purpose');
});

test('sanitizeGame: accepts a valid save, rejects anything broken', () => {
  const good = { v: 1, players: [{ name: 'Ann', level: 4 }, { name: 'Bob', level: 1 }], turn: 1, round: 3, winner: null, bag: ['Grandma', 'Pizza'], lastWord: 'Taco' };
  assert.deepEqual(Core.sanitizeGame(good), { v: 1, players: good.players, turn: 1, round: 3, winner: null, bag: ['Grandma', 'Pizza'], lastWord: 'Taco' });
  // version 1 saved the bag as indexes into the built-in list
  const old = Core.sanitizeGame({ ...good, bag: [1, 2, 500, -1, 2.5, '', 'x'.repeat(99)], lastWord: undefined });
  assert.deepEqual(old.bag, ['Pickle', 'Noodle']);
  assert.equal(old.lastWord, null);
  assert.equal(Core.sanitizeGame(null), null);
  assert.equal(Core.sanitizeGame({ players: [{ name: 'A', level: 1 }] }), null);
  assert.equal(Core.sanitizeGame({ ...good, turn: 2 }), null);
  assert.equal(Core.sanitizeGame({ ...good, players: [{ name: 'A', level: 0 }, { name: 'B', level: 1 }] }), null);
  assert.equal(Core.sanitizeGame({ ...good, players: [{ name: 'A', level: 2.5 }, { name: 'B', level: 1 }] }), null);
  assert.equal(Core.sanitizeGame({ ...good, winner: 7 }), null);
  assert.equal(Core.sanitizeGame({ ...good, winner: 0 }).winner, 0);
});
