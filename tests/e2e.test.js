// End-to-end tests in headless Chromium (run: npm install && node --test tests/e2e.test.js)
//
// The microphone is simulated: getUserMedia returns a 440 Hz tone whose volume
// the test controls, so the real audio pipeline (AnalyserNode -> RMS -> dB ->
// smoothing -> UI) is exercised with known input levels. One test instead uses
// Chromium's fake capture device playing a WAV file with a known level.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, BASE } = require('./server');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.warn('Playwright is not installed; run `npm install` to enable the end-to-end tests.');
}
const skip = !chromium && 'playwright not installed';

const CHROME_ARGS = ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'];
let server;
let origin;
let browser;

before(async () => {
  if (skip) return;
  server = await start(0);
  origin = 'http://localhost:' + server.address().port;
  browser = await chromium.launch({ args: CHROME_ARGS });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

// Runs in the page before app.js: a controllable fake mic + vibrate/wakeLock spies.
function fakeMic() {
  const mic = { amp: 0, ambientDb: 35, gain: null, ctx: null, constraints: [], vibrations: [], wakeRequests: 0, wakeReleases: 0 };
  window.__mic = mic;
  // amplitude of a sine that reads `db` with the given calibration offset
  mic.set = (db, offset) => {
    const level = db === null || db === undefined ? mic.ambientDb : db;
    mic.amp = level === null ? 0 : Math.SQRT2 * Math.pow(10, (level - (offset || 105)) / 20);
    if (mic.gain) mic.gain.gain.setValueAtTime(mic.amp, mic.ctx.currentTime);
  };
  mic.set(null);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    mic.constraints.push(JSON.parse(JSON.stringify(constraints)));
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const gain = ctx.createGain();
    gain.gain.value = mic.amp;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    mic.ctx = ctx;
    mic.gain = gain;
    return dest.stream;
  };
  Object.defineProperty(navigator, 'vibrate', {
    configurable: true,
    value: (pattern) => {
      mic.vibrations.push(pattern);
      return true;
    },
  });
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: async (type) => {
        mic.wakeRequests++;
        const s = new EventTarget();
        s.type = type;
        s.release = async () => {
          mic.wakeReleases++;
          s.dispatchEvent(new Event('release'));
        };
        return s;
      },
    },
  });
}

async function openApp(options) {
  const opts = Object.assign({ fake: true }, options);
  const context = await (opts.browser || browser).newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
  });
  if (opts.fake) await context.addInitScript(fakeMic);
  if (opts.init) await context.addInitScript(opts.init);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('dialog', (d) => d.accept());
  await page.goto(origin + BASE);
  return { page, context, errors };
}

const visible = (screen) => `#view-game [data-screen="${screen}"]:not([hidden])`;
const setLevel = (page, db, offset) => page.evaluate(([d, o]) => window.__mic.set(d, o), [db, offset]);
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const readMeter = (page) => page.evaluate(() => parseFloat(document.getElementById('dbInt').textContent + document.getElementById('dbDec').textContent));
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, (msg || '') + ` expected ${expected} ±${tol}, got ${actual}`);

// Plays one turn. `aim(target, win)` returns the dB to "say" the word at (null = stay silent).
async function playTurn(page, aim) {
  await page.click('#readyBtn');
  await page.waitForSelector(visible('quiet'));
  await page.waitForSelector(visible('reveal'), { timeout: 5000 });
  const target = parseInt(await text(page, '#revealTarget'), 10);
  const win = target - parseInt(await text(page, '#revealRange'), 10);
  const word = await text(page, '#revealWord');
  await page.click('#goBtn');
  await page.waitForSelector(visible('listen'));
  const db = aim(target, win);
  let live = null;
  await page.waitForTimeout(400);
  if (db !== null) {
    await setLevel(page, db);
    await page.waitForTimeout(450);
    live = parseFloat(await text(page, '#listenValue'));
    await page.waitForTimeout(300);
    await setLevel(page, null);
  }
  await page.waitForSelector(`${visible('result')}, ${visible('win')}`, { timeout: 12000 });
  return { target, win, word, aimed: db, live };
}

async function startGame(page, names) {
  await page.click('.tab[data-tab="game"]');
  const count = names.length;
  while (parseInt(await text(page, '#playerCount'), 10) > count) await page.click('#pcMinus');
  while (parseInt(await text(page, '#playerCount'), 10) < count) await page.click('#pcPlus');
  const inputs = await page.$$('#nameList input');
  for (let i = 0; i < count; i++) await inputs[i].fill(names[i]);
  await page.click('#startGame');
  await page.waitForSelector(visible('pass'));
}

const levels = (page) => page.$$eval('#resultScores .score-level', (els) => els.map((e) => Number(e.textContent)));

/* ------------------------------------------------------------------ */
/* app shell, PWA, offline                                             */
/* ------------------------------------------------------------------ */

test('loads under the GitHub Pages sub-path with all assets and no errors', { skip }, async () => {
  const { page, context, errors } = await openApp({ fake: false });
  assert.equal(await page.title(), 'Loud Enough');
  assert.ok((await page.$$('#gaugeTicks line')).length > 15, 'gauge ticks were drawn');
  assert.match(await text(page, '.note'), /not a certified sound level meter/);

  const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
  assert.equal(manifest.name, 'Loud Enough');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  const icons = manifest.icons.map((i) => i.src).concat(['icons/apple-touch-icon.png', 'icons/favicon.svg', 'icons/favicon-32.png']);
  for (const src of icons) {
    const res = await page.request.get(origin + BASE + src);
    assert.equal(res.status(), 200, src);
  }
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));

  for (const tab of ['game', 'settings', 'meter']) {
    await page.click(`.tab[data-tab="${tab}"]`);
    assert.equal(await page.isVisible(`#view-${tab}`), true, tab + ' view shown');
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('service worker caches the app so it opens offline', { skip }, async () => {
  const { page, context, errors } = await openApp({ fake: false });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const cache = await caches.open((await caches.keys())[0]);
    return (await cache.keys()).map((r) => new URL(r.url).pathname).sort();
  });
  for (const f of ['index.html', 'app.js', 'style.css', 'manifest.json', 'icons/icon-192.png']) {
    assert.ok(cached.includes('/Decibel-meeter/' + f), f + ' is cached');
  }

  await context.setOffline(true);
  await page.goto(origin + BASE);
  assert.equal(await page.title(), 'Loud Enough');
  assert.ok((await page.$$('#gaugeTicks line')).length > 15, 'app.js ran offline');
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(13, 8, 32)', 'CSS loaded offline');
  await page.goto(origin + BASE + 'index.html?from=homescreen');
  assert.equal(await page.isVisible('#micBtn'), true);
  assert.deepEqual(errors, []);
  await context.close();
});

/* ------------------------------------------------------------------ */
/* live meter                                                          */
/* ------------------------------------------------------------------ */

test('real capture path: raw constraints, and a known-level WAV reads ~82 dB', { skip }, async () => {
  // 1 kHz sine at amplitude 0.1 = -23 dBFS -> 82 dB with the default +105 offset
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loud-enough-'));
  const wav = path.join(dir, 'tone.wav');
  const rate = 48000;
  const n = rate * 3;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(0.1 * 32767 * Math.sin((2 * Math.PI * 1000 * i) / rate)), 44 + i * 2);
  fs.writeFileSync(wav, buf);

  const wavBrowser = await chromium.launch({
    args: CHROME_ARGS.concat(['--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav]),
  });
  try {
    await checkWavMeter(wavBrowser);
  } finally {
    await wavBrowser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function checkWavMeter(wavBrowser) {
  const { page, errors } = await openApp({
    browser: wavBrowser,
    fake: false,
    init: () => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__gum = [];
      navigator.mediaDevices.getUserMedia = async (c) => {
        const stream = await original(c);
        window.__gum.push({ constraints: JSON.parse(JSON.stringify(c)), settings: stream.getAudioTracks()[0].getSettings() });
        return stream;
      };
    },
  });
  await page.click('#micBtn');
  await page.waitForFunction(() => document.getElementById('micPill').dataset.state === 'on');
  await page.waitForTimeout(1500);
  const gum = await page.evaluate(() => window.__gum);
  assert.equal(gum.length, 1);
  assert.deepEqual(gum[0].constraints, {
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: false,
  });
  assert.equal(gum[0].settings.echoCancellation, false);
  assert.equal(gum[0].settings.noiseSuppression, false);
  assert.equal(gum[0].settings.autoGainControl, false);
  near(await readMeter(page), 82, 1, 'meter reading');
  assert.deepEqual(errors, [], 'no errors even without the Wake Lock API');
}

test('meter: accurate levels, zones, reference labels, stats, reset, graph, wake lock', { skip }, async () => {
  const { page, context, errors } = await openApp();
  assert.equal(await text(page, '#dbInt'), '--');
  await page.click('#micBtn');
  await page.waitForFunction(() => document.getElementById('micPill').dataset.state === 'on');
  assert.equal(await text(page, '#micPillText'), 'Live');
  assert.equal(await text(page, '#micBtn'), '■ Stop');
  assert.equal(await page.evaluate(() => window.__mic.wakeRequests), 1, 'wake lock requested');

  const zone = () => page.$eval('#readout', (el) => el.dataset.zone);
  const activeRef = () => page.$eval('#refChips .ref.active', (el) => el.dataset.ref);
  const cases = [
    [30, 'green', 'whisper'],
    [50, 'green', 'talk'],
    [70, 'yellow', 'talk'],
    [90, 'red', 'shout'],
  ];
  for (const [db, z, ref] of cases) {
    await setLevel(page, db);
    await page.waitForTimeout(900);
    near(await readMeter(page), db, 0.3, db + ' dB reading');
    assert.equal(await zone(), z, db + ' dB zone');
    assert.equal(await activeRef(), ref, db + ' dB reference label');
  }

  // ~20 updates per second
  const updates = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const off = window.LoudEnough.Mic.frames.on(() => n++);
        setTimeout(() => {
          off();
          resolve(n);
        }, 2000);
      })
  );
  assert.ok(updates >= 36 && updates <= 42, 'updates in 2 s: ' + updates);

  const stat = async (id) => parseFloat(await text(page, '#' + id));
  near(await stat('statMax'), 90, 0.3, 'max');
  near(await stat('statMin'), 30, 0.5, 'min');
  const avg = await stat('statAvg');
  assert.ok(avg > 80 && avg < 90, 'energy average ' + avg);

  // gauge arc filled up to 90 dB: green and yellow zones full, red partly
  const dash = await page.$$eval('#gaugeLevels path', (els) => els.map((e) => parseFloat(e.style.strokeDasharray)));
  assert.ok(dash[0] > 85 && dash[1] > 40 && dash[2] > 10 && dash[2] < 60, 'gauge arcs ' + dash);
  assert.notEqual(await page.getAttribute('#peakTick', 'd'), '', 'peak marker shown');

  await page.click('#resetStats');
  assert.equal(await text(page, '#statMax'), '--');
  await page.waitForTimeout(600);
  near(await stat('statMax'), 90, 0.3, 'max after reset');
  near(await stat('statMin'), 90, 0.3, 'min after reset');

  // the graph has the red line from the 90 dB part
  const graph = await page.evaluate(() => {
    const c = document.getElementById('graph');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    let green = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] < 120 && d[i + 2] < 130 && d[i + 3] > 200) red++;
      if (d[i] < 100 && d[i + 1] > 180 && d[i + 2] < 160 && d[i + 3] > 200) green++;
    }
    return { red, green };
  });
  assert.ok(graph.red > 200 && graph.green > 50, 'graph line pixels ' + JSON.stringify(graph));

  await page.click('#micBtn');
  assert.equal(await text(page, '#micPillText'), 'Mic off');
  assert.equal(await text(page, '#dbInt'), '--');
  assert.equal(await page.evaluate(() => window.__mic.wakeReleases), 1, 'wake lock released');
  assert.deepEqual(errors, []);
  await context.close();
});

test('meter: a blocked microphone shows a helpful message', { skip }, async () => {
  const { page, context } = await openApp({
    fake: false,
    init: () => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    },
  });
  await page.click('#micBtn');
  await page.waitForSelector('#meterError:not([hidden])');
  assert.match(await text(page, '#meterError'), /blocked/i);
  assert.equal(await text(page, '#micPillText'), 'Mic off');
  assert.equal(await text(page, '#micBtn'), '🎤 Start meter');
  await context.close();
});

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

test('settings: calibration offset shifts readings, reference match works, all saved', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await page.click('.tab[data-tab="settings"]');
  assert.equal(await text(page, '#offsetValue'), '+105 dB');
  await page.click('#calMic');
  await setLevel(page, 60);
  await page.waitForTimeout(800);
  near(parseFloat(await text(page, '#calReading')), 60, 0.3, 'reading at +105');

  for (let i = 0; i < 6; i++) await page.click('#offsetPlus');
  assert.equal(await text(page, '#offsetValue'), '+111 dB');
  await page.waitForTimeout(200);
  near(parseFloat(await text(page, '#calReading')), 66, 0.3, 'reading at +111');

  await page.fill('#offset', '90.5');
  assert.equal(await text(page, '#offsetValue'), '+90.5 dB');

  await page.fill('#refDb', '65');
  await page.click('#refMatch');
  await page.waitForTimeout(200);
  assert.equal(await text(page, '#offsetValue'), '+110 dB');
  near(parseFloat(await text(page, '#calReading')), 65, 0.3, 'reading after match');

  await page.click('#settingsOptions [data-setting="difficulty"][value="easy"]');
  await page.reload();
  await page.click('.tab[data-tab="settings"]');
  assert.equal(await text(page, '#offsetValue'), '+110 dB');
  assert.equal(await page.inputValue('#offset'), '110');
  assert.equal(await page.isChecked('#settingsOptions [data-setting="difficulty"][value="easy"]'), true);
  await page.click('.tab[data-tab="game"]');
  assert.equal(await page.isChecked('#setupOptions [data-setting="difficulty"][value="easy"]'), true, 'setup mirrors the setting');

  await page.click('.tab[data-tab="settings"]');
  assert.equal(await text(page, '#offsetReset'), 'Reset to +105');
  await page.click('#offsetReset');
  assert.equal(await text(page, '#offsetValue'), '+105 dB');
  assert.deepEqual(errors, []);
  await context.close();
});

/* ------------------------------------------------------------------ */
/* game                                                                */
/* ------------------------------------------------------------------ */

test('game setup: 2–10 players, optional names', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await page.click('.tab[data-tab="game"]');
  for (let i = 0; i < 12; i++) await page.click('#pcPlus', { force: true });
  assert.equal(await text(page, '#playerCount'), '10');
  assert.equal(await page.isDisabled('#pcPlus'), true);
  assert.equal((await page.$$('#nameList input')).length, 10);
  for (let i = 0; i < 12; i++) await page.click('#pcMinus', { force: true });
  assert.equal(await text(page, '#playerCount'), '2');
  assert.equal(await page.isDisabled('#pcMinus'), true);
  await page.click('#pcPlus');
  const inputs = await page.$$('#nameList input');
  await inputs[0].fill('Ann');
  await inputs[2].fill('  Cat  ');
  await page.click('#startGame');
  await page.waitForSelector(visible('pass'));
  assert.equal(await text(page, '#passName'), 'Ann');
  assert.equal(await text(page, '#passWindow'), '5', 'Normal difficulty by default');
  await page.click('#scoresBtn');
  assert.deepEqual(await page.$$eval('#scoresList .score-name', (els) => els.map((e) => e.textContent)), ['Ann', 'Player 2', 'Cat']);
  await page.click('#scoresClose');
  assert.equal(await page.isVisible('#scoresModal'), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('game: perfect levels up; too loud / too quiet / silence fail, reset and vibrate', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await startGame(page, ['Ann', 'Bob']);

  // Ann: perfect (middle of the window)
  let turn = await playTurn(page, (t, w) => t - w / 2);
  assert.ok(turn.target >= 50 && turn.target <= 85, 'target ' + turn.target);
  assert.equal(turn.win, 5);
  near(turn.live, turn.aimed, 0.3, 'live bar value');
  assert.equal(await text(page, '#resultVerdict'), 'Perfect!');
  near(parseFloat(await text(page, '#resultPeak')), turn.aimed, 0.3, 'peak');
  assert.match(await text(page, '#resultLevel'), /level 1 → 2/);
  assert.deepEqual(await levels(page), [2, 1]);
  assert.equal(await page.evaluate(() => window.__mic.vibrations.length), 0, 'no buzz on success');
  assert.equal(await text(page, '#nextBtn'), 'Next: Bob →');

  // Bob: too loud
  await page.click('#nextBtn');
  assert.equal(await text(page, '#passName'), 'Bob');
  turn = await playTurn(page, (t) => t + 3);
  assert.equal(await text(page, '#resultVerdict'), 'Too loud!');
  assert.match(await text(page, '#resultDelta'), /over the line/);
  assert.equal(await page.evaluate(() => window.__mic.vibrations.length), 1, 'buzz on fail');

  // Ann: heard, but under the window -> back to level 1
  await page.click('#nextBtn');
  turn = await playTurn(page, (t, w) => t - w - 3);
  assert.equal(await text(page, '#resultVerdict'), 'Too quiet!');
  assert.match(await text(page, '#resultLevel'), /Ann drops from level 2 back to 1/);
  assert.deepEqual(await levels(page), [1, 1]);

  // Bob: says nothing at all
  await page.click('#nextBtn');
  turn = await playTurn(page, () => null);
  assert.equal(await text(page, '#resultVerdict'), 'Too quiet!');
  assert.match(await text(page, '#resultDelta'), /didn't hear anything/);
  assert.equal(await page.evaluate(() => window.__mic.vibrations.length), 3);
  assert.deepEqual(errors, []);
  await context.close();
});

test('game: loudest → softest and softest → loudest target orders, saved and mirrored', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await page.click('.tab[data-tab="game"]');
  const setupOrder = (v) => `#setupOptions [data-setting="targetOrder"][value="${v}"]`;
  const settingsOrder = (v) => `#settingsOptions [data-setting="targetOrder"][value="${v}"]`;
  assert.equal(await page.isChecked(setupOrder('random')), true, 'random by default');
  await page.click(setupOrder('descending'));
  assert.match(await text(page, '#setupOptions [data-order-help]'), /85 dB, then 81/);
  await startGame(page, ['Ann', 'Bob']);
  assert.equal(await text(page, '#gameMode'), 'Solo · 📉');
  assert.equal(await page.isVisible('#passTarget'), true);
  assert.equal(await text(page, '#passTargetValue'), '85');

  let turn = await playTurn(page, (t, w) => t - w / 2); // Ann, level 1
  assert.equal(turn.target, 85);
  assert.equal(await text(page, '#resultVerdict'), 'Perfect!');
  await page.click('#nextBtn');
  turn = await playTurn(page, (t) => t + 2); // Bob, level 1: too loud
  assert.equal(turn.target, 85);
  await page.click('#nextBtn');
  assert.equal(await text(page, '#passTargetValue'), '81');
  turn = await playTurn(page, (t) => t + 2); // Ann, level 2: a softer target, then a miss
  assert.equal(turn.target, 81);
  assert.equal(await text(page, '#resultVerdict'), 'Too loud!');
  assert.deepEqual(await levels(page), [1, 1]);

  // the choice is saved and mirrored in Settings
  await page.click('.tab[data-tab="settings"]');
  assert.equal(await page.isChecked(settingsOrder('descending')), true);
  await page.reload();
  await page.click('.tab[data-tab="game"]');
  await page.click('#continueBtn');
  await page.waitForSelector(visible('pass'));
  assert.equal(await text(page, '#passName'), 'Bob');
  assert.equal(await text(page, '#passTargetValue'), '85');
  turn = await playTurn(page, (t, w) => t - w / 2); // Bob, level 1 -> 2
  assert.equal(turn.target, 85);
  await page.click('#nextBtn');
  assert.equal(await text(page, '#passName'), 'Ann');
  assert.equal(await text(page, '#passTargetValue'), '85', 'after a miss Ann starts loud again');

  // softest → loudest: Ann (level 1) starts at 50 dB, Bob (level 2) at 54 dB
  await page.click('.tab[data-tab="settings"]');
  await page.click(settingsOrder('ascending'));
  assert.match(await text(page, '#settingsOptions [data-order-help]'), /50 dB, then 54/);
  await page.click('.tab[data-tab="game"]');
  assert.equal(await text(page, '#gameMode'), 'Solo · 📈');
  assert.equal(await text(page, '#passTargetIcon'), '📈');
  assert.equal(await text(page, '#passTargetValue'), '50');
  turn = await playTurn(page, (t, w) => t - w / 2);
  assert.equal(turn.target, 50);
  assert.equal(await text(page, '#resultVerdict'), 'Perfect!');
  await page.click('#nextBtn');
  assert.equal(await text(page, '#passTargetValue'), '54');
  turn = await playTurn(page, (t, w) => t - w / 2);
  assert.equal(turn.target, 54);

  // back to random hides the fixed target
  await page.click('.tab[data-tab="settings"]');
  await page.click(settingsOrder('random'));
  await page.click('.tab[data-tab="game"]');
  await page.click('#nextBtn');
  assert.equal(await page.isVisible('#passTarget'), false);
  assert.equal(await text(page, '#gameMode'), 'Solo');
  assert.deepEqual(errors, []);
  await context.close();
});

test('game: resumes after reload, Hard windows shrink to 2 and 1 dB, level 10 wins', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await page.evaluate(() => {
    localStorage.setItem('loudEnough.settings.v1', JSON.stringify({ v: 2, offset: 105, difficulty: 'hard' }));
    localStorage.setItem(
      'loudEnough.game.v1',
      JSON.stringify({ v: 1, players: [{ name: 'Ann', level: 9 }, { name: 'Bob', level: 4 }], turn: 1, round: 7, winner: null, bag: [] })
    );
  });
  await page.reload();
  await page.click('.tab[data-tab="game"]');
  assert.equal(await page.isVisible('#resumeCard'), true);
  assert.match(await text(page, '#resumeInfo'), /round 7 · Ann leads on level 9/);
  await page.click('#continueBtn');
  await page.waitForSelector(visible('pass'));
  assert.equal(await text(page, '#passName'), 'Bob');
  assert.equal(await text(page, '#passWindow'), '2');

  let turn = await playTurn(page, (t, w) => t - w / 2);
  assert.equal(turn.win, 2);
  assert.equal(await text(page, '#resultVerdict'), 'Perfect!');
  assert.deepEqual(await levels(page), [9, 5]);
  assert.equal(await text(page, '#gameRound'), 'Round 8');

  await page.click('#nextBtn');
  assert.equal(await text(page, '#passWindow'), '1');
  turn = await playTurn(page, (t) => t - 0.5);
  assert.equal(turn.win, 1);
  await page.waitForSelector(visible('win'));
  assert.equal(await text(page, '#winName'), 'Ann');
  assert.match(await text(page, '#winLast'), new RegExp(turn.word));
  assert.deepEqual(await page.$$eval('#winScores .score-level', (els) => els.map((e) => Number(e.textContent))), [10, 5]);

  await page.reload();
  await page.click('.tab[data-tab="game"]');
  assert.equal(await text(page, '#resumeTitle'), 'Last game', 'the result survives a reload');
  assert.equal(await text(page, '#resumeInfo'), 'Ann won');
  await page.click('#continueBtn');
  await page.waitForSelector(visible('win'));
  assert.equal(await text(page, '#winName'), 'Ann');
  assert.deepEqual(errors, []);
  await context.close();
});

test('game: a noisy room raises the target and the word is still detected', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await page.evaluate(() => {
    window.__mic.ambientDb = 62;
    window.__mic.set(null);
  });
  await startGame(page, ['Ann', 'Bob']);
  const turn = await playTurn(page, (t, w) => t - w / 2);
  assert.ok(turn.target >= 62 + 6 + 5 + 1, 'target raised to ' + turn.target);
  assert.equal(await text(page, '#resultVerdict'), 'Perfect!');
  assert.deepEqual(errors, []);
  await context.close();
});

test('game: leaving the tab mid-turn cancels that turn without penalty', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await startGame(page, ['Ann', 'Bob']);
  await page.click('#readyBtn');
  await page.waitForSelector(visible('quiet'));
  await page.click('.tab[data-tab="meter"]');
  await page.click('.tab[data-tab="game"]');
  assert.equal(await page.isVisible(visible('pass')), true);
  assert.equal(await text(page, '#passName'), 'Ann');
  // the turn can be played normally afterwards
  await playTurn(page, (t, w) => t - w / 2);
  assert.equal(await text(page, '#resultVerdict'), 'Perfect!');
  assert.deepEqual(errors, []);
  await context.close();
});

test('game: play with your own words', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await page.click('.tab[data-tab="game"]');
  assert.equal(await page.isVisible('#setupOptions [data-words-editor]'), false, 'editor hidden for built-in words');
  await page.click('#setupOptions [data-setting="wordSource"][value="custom"]');
  assert.equal(await page.isVisible('#setupOptions [data-words-editor]'), true);
  assert.match(await text(page, '#setupOptions [data-words-help]'), /at least one word/);
  await page.fill('#setupOptions [data-setting="customWords"]', 'Pizza party\nGrandma, Grandpa\ngrandma');
  assert.equal(await text(page, '#setupOptions [data-word-count]'), '3 words');
  assert.match(await text(page, '#setupOptions [data-words-help]'), /only your 3 words/);

  // mirrored in Settings and saved
  await page.click('.tab[data-tab="settings"]');
  assert.equal(await page.inputValue('#settingsOptions [data-setting="customWords"]'), 'Pizza party\nGrandma, Grandpa\ngrandma');
  await page.reload();
  await page.click('.tab[data-tab="game"]');
  assert.equal(await page.isChecked('#setupOptions [data-setting="wordSource"][value="custom"]'), true);

  await startGame(page, ['Ann', 'Bob']);
  const words = [];
  for (let i = 0; i < 4; i++) {
    const turn = await playTurn(page, (t, w) => t - w / 2);
    words.push(turn.word);
    await page.click('#nextBtn');
  }
  for (const w of words) assert.ok(['Pizza party', 'Grandma', 'Grandpa'].includes(w), w);
  assert.equal(new Set(words.slice(0, 3)).size, 3, 'all three before any repeat: ' + words);
  for (let i = 1; i < words.length; i++) assert.notEqual(words[i], words[i - 1]);

  // "Both" mixes them with the built-in list
  await page.click('.tab[data-tab="settings"]');
  await page.click('#settingsOptions [data-setting="wordSource"][value="both"]');
  assert.equal(await text(page, '#settingsOptions [data-both-count]'), '100 + 3');
  assert.match(await text(page, '#settingsOptions [data-words-help]'), /mixed in with the 100 built-in/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('settings: calibrate with your voice sets normal talking to 60 dB', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await page.click('.tab[data-tab="settings"]');
  // steady background only: no talking heard, offset unchanged
  await page.click('#voiceCal');
  await page.waitForFunction(() => /Keep talking/.test(document.getElementById('voiceCal').textContent));
  await page.waitForFunction(() => !document.getElementById('voiceCal').disabled, null, { timeout: 8000 });
  assert.match(await text(page, '#toast'), /Couldn't hear clear talking/);
  assert.equal(await text(page, '#offsetValue'), '+105 dB');

  // "talking" that reads 48 dB with pauses: the offset moves up by 12 dB
  await page.evaluate(() => {
    let on = false;
    window.__talk = setInterval(() => {
      on = !on;
      window.__mic.set(on ? 48 : null);
    }, 300);
  });
  await page.click('#voiceCal');
  await page.waitForFunction(() => !document.getElementById('voiceCal').disabled, null, { timeout: 8000 });
  await page.evaluate(() => clearInterval(window.__talk));
  assert.match(await text(page, '#toast'), /Normal talking now reads about 60 dB/);
  const offset = parseFloat((await text(page, '#offsetValue')).replace('+', ''));
  near(offset, 117, 1, 'offset after voice calibration');
  assert.equal(await text(page, '#voiceCal'), '🗣️ Calibrate with my voice');
  assert.deepEqual(errors, []);
  await context.close();
});

test('settings: an untouched +94 from version 1 moves to the new default', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await page.evaluate(() => localStorage.setItem('loudEnough.settings.v1', JSON.stringify({ offset: 94, targetOrder: 'descending' })));
  await page.reload();
  await page.click('.tab[data-tab="settings"]');
  assert.equal(await text(page, '#offsetValue'), '+105 dB');
  assert.equal(await page.isChecked('#settingsOptions [data-setting="targetOrder"][value="descending"]'), true);
  assert.deepEqual(errors, []);
  await context.close();
});

/* ------------------------------------------------------------------ */
/* team battle                                                         */
/* ------------------------------------------------------------------ */

// One team-battle turn. `aim(limit)` returns the dB to say the word at (null = silence).
async function playBattleTurn(page, aim) {
  await page.click('#readyBtn');
  await page.waitForSelector(visible('reveal'), { timeout: 5000 });
  const limit = parseInt(await text(page, '#revealTarget'), 10);
  const word = await text(page, '#revealWord');
  const maxNote = await page.isVisible('#revealMax');
  await page.click('#goBtn');
  await page.waitForSelector(visible('listen'));
  const db = aim(limit);
  await page.waitForTimeout(400);
  if (db !== null) {
    await setLevel(page, db);
    await page.waitForTimeout(750);
    await setLevel(page, null);
  }
  await page.waitForSelector(visible('result'), { timeout: 12000 });
  return { limit, word, maxNote, verdict: await text(page, '#resultVerdict') };
}

async function setupBattle(page, teams, teamCount) {
  await page.click('.tab[data-tab="game"]');
  await page.click('input[name="gameMode"][value="team"]');
  await page.click(`input[name="teamCount"][value="${teamCount}"]`);
  for (let t = 0; t < teams.length; t++) {
    await page.fill('#teamName' + t, teams[t].name);
    while (parseInt(await text(page, `#t${t}Count`), 10) > teams[t].players.length) await page.click(`#t${t}Minus`);
    while (parseInt(await text(page, `#t${t}Count`), 10) < teams[t].players.length) await page.click(`#t${t}Plus`);
    const inputs = await page.$$(`#t${t}Names input`);
    for (let i = 0; i < teams[t].players.length; i++) await inputs[i].fill(teams[t].players[i]);
  }
}

const tableRows = (page, sel) =>
  page.$$eval(sel + ' tbody tr', (rows) => rows.map((r) => Array.from(r.cells).map((c) => c.textContent.trim())));

test('team battle on one phone: best of three, 3 strikes lose a game, same word for both teams, starts alternate', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await setupBattle(page, [{ name: 'Reds', players: ['Ann', 'Bob', 'Cat'] }, { name: 'Blues', players: ['Dan', 'Eve', 'Fay'] }], 2);
  assert.equal(await page.isVisible('#soloPlayersCard'), false);
  assert.equal(await page.isVisible('#setupOptions [data-setting="difficulty"][value="easy"]'), false, 'solo-only options hidden');
  assert.equal(await text(page, '#ladderPreview'), '50 → 85 → 115 dB');
  assert.equal(await text(page, '#startGame'), 'Start team battle ⚔️');
  await page.click('#startGame');
  await page.waitForSelector(visible('pass'));
  assert.equal(await text(page, '#passMatch'), 'Game 1 of 3 · Reds 0 – 0 Blues');
  assert.equal(await text(page, '#passTeam'), 'Reds · step 1 of 3');
  assert.equal(await text(page, '#passName'), 'Ann');
  assert.equal(await text(page, '#passLevel'), '50');
  assert.equal(await text(page, '#passWord'), '🆕 New word coming up!');
  assert.equal(await text(page, '#passStrikes'), 'Strikes⬜⬜⬜');
  assert.equal(await text(page, '#gameRound'), 'Reds');
  assert.equal(await text(page, '#gameMode'), '❌ 0/3');

  /* ---- game 1: Reds start ---- */
  let turn = await playBattleTurn(page, (limit) => limit - 2); // Ann, 2 under 50
  assert.equal(turn.limit, 50);
  assert.equal(turn.maxNote, false, 'no "scream" note on a limit the phone can measure');
  const word1 = turn.word;
  assert.equal(turn.verdict, 'Great!');
  assert.match(await text(page, '#resultLevel'), /Saved: 48\.\d for Reds at the 50 dB limit/);
  assert.equal(await text(page, '#nextBtn'), 'Next: Bob →');

  await page.click('#nextBtn');
  assert.equal(await text(page, '#passWord'), '🔁 The word: ' + word1);
  turn = await playBattleTurn(page, (limit) => limit + 2); // Bob goes over 85: strike 1
  assert.equal(turn.word, word1);
  assert.equal(turn.verdict, 'Too loud!');
  assert.equal(await text(page, '#resultLevel'), 'Strike 1 of 3! Reds goes back to step 1, same word.');
  assert.equal(await text(page, '#nextBtn'), 'Start again: Ann →');
  assert.equal(await page.evaluate(() => window.__mic.vibrations.length), 1);
  assert.deepEqual((await tableRows(page, '#resultBattle')).map((r) => r[1]), ['👉', '—', '—'], 'the try was wiped');

  await page.click('#nextBtn');
  assert.equal(await text(page, '#gameMode'), '❌ 1/3');
  assert.equal(await text(page, '#passStrikes'), 'Strikes❌⬜⬜');
  assert.equal(await text(page, '#passWord'), '🔁 The word: ' + word1, 'same word after a strike');
  turn = await playBattleTurn(page, (limit) => limit - 1); // Ann again
  assert.equal(turn.word, word1);
  assert.equal(turn.verdict, 'Amazing!');

  // a reload in the middle of the ladder keeps the word, the step and the strikes
  await page.reload();
  await page.click('.tab[data-tab="game"]');
  assert.equal(await text(page, '#resumeInfo'), 'Reds 0 – 0 Blues · game 1 of 3');
  await page.click('#continueBtn');
  await page.waitForSelector(visible('pass'));
  assert.equal(await text(page, '#passTeam'), 'Reds · step 2 of 3');
  assert.equal(await text(page, '#passName'), 'Bob');
  assert.equal(await text(page, '#passWord'), '🔁 The word: ' + word1);
  assert.equal(await text(page, '#gameMode'), '❌ 1/3');

  turn = await playBattleTurn(page, () => null); // Bob says nothing
  assert.equal(turn.verdict, "Didn't hear you!");
  assert.equal(await text(page, '#nextBtn'), 'Try again →');
  await page.click('#nextBtn');
  assert.equal(await text(page, '#passName'), 'Bob');
  assert.equal(await text(page, '#gameMode'), '❌ 1/3', 'not hearing you is not a strike');
  turn = await playBattleTurn(page, (limit) => limit - 1);
  assert.equal(turn.limit, 85);

  await page.click('#nextBtn');
  turn = await playBattleTurn(page, () => 100); // Cat: 115 is above what the phone measures
  assert.equal(turn.limit, 115);
  assert.equal(turn.maxNote, true, 'the "scream as loud as you can" note shows');
  assert.match(await text(page, '#resultDelta'), /dB under this phone's maximum \(about 105 dB\)/);
  assert.match(await text(page, '#resultLevel'), /Ladder complete/);
  assert.equal(await text(page, '#nextBtn'), "Blues's turn →");

  await page.click('#nextBtn');
  assert.equal(await text(page, '#passTeam'), 'Blues · step 1 of 3');
  assert.equal(await text(page, '#passWord'), '🔁 The word: ' + word1, 'Blues get the same word');
  for (const db of [47, 84.5]) {
    turn = await playBattleTurn(page, () => db);
    assert.equal(turn.word, word1);
    await page.click('#nextBtn');
  }
  turn = await playBattleTurn(page, () => 101);
  assert.equal(await text(page, '#nextBtn'), 'See game 1 result 🏆');
  await page.click('#nextBtn');
  await page.waitForSelector(visible('win'));
  assert.equal(await text(page, '#winName'), 'Blues');
  assert.equal(await text(page, '#winSuffix'), 'win game 1!');
  assert.equal(await text(page, '#winMsg'), 'Closest at 2 of 3 limits (Reds: 1). Next game: Blues start.');
  assert.equal(await text(page, '#winLast'), 'Match: Reds 0 – 1 Blues · best of 3');
  assert.equal(await page.isVisible('#nextGameBtn'), true);
  assert.equal(await page.isVisible('#winButtons'), false);
  const rows = await tableRows(page, '#winBattle');
  assert.match(rows[0][1], /^49\.\d 🏆$/);
  assert.match(rows[1][2], /^84\.\d 🏆$/);
  assert.match(rows[2][2], /^10[01]\.\d 🏆$/);
  assert.deepEqual(await page.$$eval('#winBattle tfoot tr', (trs) => trs.map((tr) => tr.textContent)), ['Strikes❌–', 'Limits won12']);

  // the match survives a reload between games
  await page.reload();
  await page.click('.tab[data-tab="game"]');
  assert.equal(await text(page, '#resumeInfo'), 'Reds 0 – 1 Blues · game 1 of 3');
  await page.click('#continueBtn');
  await page.waitForSelector(visible('win'));
  assert.equal(await text(page, '#nextGameBtn'), 'Start game 2 →');

  /* ---- game 2: Blues start, and strike out ---- */
  await page.click('#nextGameBtn');
  await page.waitForSelector(visible('pass'));
  assert.equal(await text(page, '#passMatch'), 'Game 2 of 3 · Reds 0 – 1 Blues');
  assert.equal(await text(page, '#passTeam'), 'Blues · step 1 of 3');
  assert.equal(await text(page, '#passName'), 'Dan');
  assert.equal(await text(page, '#passWord'), '🆕 New word coming up!');
  assert.equal(await text(page, '#gameMode'), '❌ 0/3');
  let word2 = null;
  for (let strike = 1; strike <= 3; strike++) {
    turn = await playBattleTurn(page, () => 55);
    word2 = word2 || turn.word;
    assert.equal(turn.word, word2, 'same word through the strikes');
    if (strike < 3) {
      assert.equal(turn.verdict, 'Too loud!');
      await page.click('#nextBtn');
    }
  }
  assert.notEqual(word2, word1, 'a new word for a new game');
  assert.equal(turn.verdict, 'Strike 3!');
  assert.equal(await text(page, '#resultLevel'), 'Blues struck out: Reds win game 2!');
  await page.click('#nextBtn');
  await page.waitForSelector(visible('win'));
  assert.equal(await text(page, '#winSuffix'), 'win game 2!');
  assert.equal(await text(page, '#winName'), 'Reds');
  assert.equal(await text(page, '#winLast'), 'Match: Reds 1 – 1 Blues · best of 3');

  /* ---- game 3: Reds start, strike out, Blues win the match ---- */
  await page.click('#nextGameBtn');
  await page.waitForSelector(visible('pass'));
  assert.equal(await text(page, '#passTeam'), 'Reds · step 1 of 3');
  for (let strike = 1; strike <= 3; strike++) {
    await playBattleTurn(page, () => 56);
    await page.click('#nextBtn');
  }
  await page.waitForSelector(visible('win'));
  assert.equal(await text(page, '#winName'), 'Blues');
  assert.equal(await text(page, '#winSuffix'), 'win the match!');
  assert.equal(await text(page, '#winMsg'), 'Game 3: Reds struck out (3 strikes). Final score 2–1 in games.');
  assert.equal(await page.isVisible('#nextGameBtn'), false);
  assert.equal(await page.isVisible('#winButtons'), true);
  assert.equal(await text(page, '#rematchBtn'), '🔁 New match');
  const history = await page.$$eval('#winHistory li', (lis) => lis.map((li) => li.textContent));
  assert.equal(history.length, 3);
  assert.match(history[0], /^Game 1🏅 Blues2–1 on limits/);
  assert.match(history[1], /^Game 2🏅 RedsBlues struck out/);
  assert.match(history[2], /^Game 3🏅 BluesReds struck out/);

  await page.reload();
  await page.click('.tab[data-tab="game"]');
  assert.equal(await text(page, '#resumeTitle'), 'Last game', 'the match result survives a reload');
  assert.equal(await text(page, '#resumeInfo'), 'Blues won the match 2–1');
  assert.equal(await text(page, '#continueBtn'), '🏆 See results');
  assert.equal(await page.isChecked('input[name="gameMode"][value="team"]'), true, 'setup remembered');
  assert.equal(await page.inputValue('#teamName1'), 'Blues');
  assert.deepEqual(errors, []);
  await context.close();
});

test('team battle with one team per phone: shared ladder size, strikes, rotation, then back to solo', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await setupBattle(page, [{ name: 'Us', players: ['Ann', 'Bob'] }], 1);
  assert.equal(await page.isVisible('#teamCard1'), false);
  assert.equal(await page.isVisible('#otherTeamRow'), true);
  assert.equal(await text(page, '#ladderPreview'), '50 → 85 → 115 dB', 'sized for the other team (3 by default)');
  assert.match(await text(page, '#ladderHelp'), /3 limits; your players take turns/);
  await page.click('#otherMinus');
  assert.equal(await text(page, '#ladderPreview'), '50 → 115 dB');
  assert.equal(await page.$eval('#ladderPreview span:last-child', (el) => el.className), 'top', '115 is above what the phone can measure');
  await page.click('#otherPlus');
  await page.click('#startGame');
  await page.waitForSelector(visible('pass'));
  assert.equal(await page.isVisible('#passMatch'), false, 'no match score for one team');
  assert.equal(await text(page, '#passTeam'), 'Us · step 1 of 3');
  let turn = await playBattleTurn(page, () => 52);
  assert.equal(turn.verdict, 'Too loud!');
  await page.click('#nextBtn');
  assert.equal(await text(page, '#gameMode'), '❌ 1/3');
  turn = await playBattleTurn(page, () => 48);
  assert.equal(turn.verdict, 'Great!');
  await page.click('#nextBtn');
  turn = await playBattleTurn(page, () => 84); // Bob
  await page.click('#nextBtn');
  assert.equal(await text(page, '#passName'), 'Ann', 'Ann takes the third limit');
  assert.equal(await text(page, '#passBattleRule'), 'Scream as loud as you can: this phone can only measure up to about 105 dB.');
  turn = await playBattleTurn(page, () => 100);
  assert.equal(await text(page, '#nextBtn'), 'See the results 🏆');
  await page.click('#nextBtn');
  await page.waitForSelector(visible('win'));
  assert.equal(await text(page, '#winName'), 'Us');
  assert.equal(await text(page, '#winSuffix'), 'finished!');
  assert.match(await text(page, '#winMsg'), /All 3 limits done with 1 strike, 1[89]\.\d dB under in total/);
  assert.equal((await page.$$('#winBattle thead th')).length, 2, 'one team column');
  assert.match(await page.$eval('#winBattle tfoot', (el) => el.textContent), /Strikes❌.*Total under/);
  assert.equal(await page.isVisible('#winHistory'), false);
  assert.equal(await text(page, '#rematchBtn'), '🔁 Play again');

  await page.click('#rematchBtn');
  await page.waitForSelector(visible('pass'));
  assert.equal(await text(page, '#passTeam'), 'Us · step 1 of 3', 'rematch keeps the ladder size');
  assert.equal(await text(page, '#gameMode'), '❌ 0/3');

  // back to a solo game in the same session: no team leftovers on screen
  await page.click('#quitBtn');
  await page.waitForSelector(visible('setup'));
  await page.click('input[name="gameMode"][value="solo"]');
  assert.equal(await page.isVisible('#setupOptions [data-setting="difficulty"][value="easy"]'), true);
  assert.equal(await page.isVisible('#ladderCard'), false);
  const inputs = await page.$$('#nameList input');
  await inputs[0].fill('Zed');
  await page.click('#startGame');
  await page.waitForSelector(visible('pass'));
  assert.equal(await page.isVisible('#passTeam'), false);
  assert.equal(await page.isVisible('#passStrikes'), false);
  assert.equal(await text(page, '.level-badge'), 'Level 1/10');
  assert.equal(await text(page, '#gameRound'), 'Round 1');
  turn = await playTurn(page, (t, w) => t - w / 2);
  assert.equal(await text(page, '#resultVerdict'), 'Perfect!');
  assert.equal(await text(page, '#resultTargetLabel'), 'Target');
  assert.equal(await page.isVisible('#resultTeam'), false);
  assert.equal(await page.isVisible('#resultBattle'), false);
  assert.equal(await page.isVisible('#resultScores'), true);
  assert.equal(await page.$eval(visible('result'), (el) => el.hasAttribute('data-team')), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('team battle: a room too noisy for the limit can be re-measured without penalty', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await page.evaluate(() => {
    window.__mic.ambientDb = 48;
    window.__mic.set(null);
  });
  await setupBattle(page, [{ name: 'Reds', players: ['Ann', 'Bob'] }, { name: 'Blues', players: ['Dan', 'Eve'] }], 2);
  await page.click('#startGame');
  await page.waitForSelector(visible('pass'));
  await page.click('#readyBtn');
  await page.waitForSelector(visible('reveal'), { timeout: 5000 });
  assert.equal(await page.isVisible('#revealNoisy'), true);
  assert.match(await text(page, '#revealNoisyText'), /Too noisy for this limit: the room was 48 dB/);
  const word = await text(page, '#revealWord');
  // everyone hushes, measure again
  await page.evaluate(() => {
    window.__mic.ambientDb = 40;
    window.__mic.set(null);
  });
  await page.click('#remeasureBtn');
  await page.waitForSelector(visible('quiet'));
  await page.waitForSelector(visible('reveal'), { timeout: 5000 });
  assert.equal(await page.isVisible('#revealNoisy'), false);
  assert.equal(await text(page, '#revealWord'), word, 'same word');
  assert.equal(await text(page, '#gameMode'), '❌ 0/3', 'no strike');
  // and a soft 47 dB word in that room is heard and saved
  await page.click('#goBtn');
  await page.waitForSelector(visible('listen'));
  await page.waitForTimeout(400);
  await setLevel(page, 47);
  await page.waitForTimeout(750);
  await setLevel(page, null);
  await page.waitForSelector(visible('result'), { timeout: 12000 });
  assert.equal(await text(page, '#resultVerdict'), 'Great!');
  assert.deepEqual(errors, []);
  await context.close();
});
