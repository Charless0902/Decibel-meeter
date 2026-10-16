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
    mic.amp = level === null ? 0 : Math.SQRT2 * Math.pow(10, (level - (offset || 94)) / 20);
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

async function startGame(page, names, team) {
  await page.click('.tab[data-tab="game"]');
  const count = names.length;
  while (parseInt(await text(page, '#playerCount'), 10) > count) await page.click('#pcMinus');
  while (parseInt(await text(page, '#playerCount'), 10) < count) await page.click('#pcPlus');
  const inputs = await page.$$('#nameList input');
  for (let i = 0; i < count; i++) await inputs[i].fill(names[i]);
  if (team) await page.check('#teamModeSetup');
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

test('real capture path: raw constraints, and a known-level WAV reads ~71 dB', { skip }, async () => {
  // 1 kHz sine at amplitude 0.1 = -23 dBFS -> 71 dB with the default +94 offset
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
  near(await readMeter(page), 71, 1, 'meter reading');
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
  assert.equal(await text(page, '#offsetValue'), '+94 dB');
  await page.click('#calMic');
  await setLevel(page, 60);
  await page.waitForTimeout(800);
  near(parseFloat(await text(page, '#calReading')), 60, 0.3, 'reading at +94');

  for (let i = 0; i < 6; i++) await page.click('#offsetPlus');
  assert.equal(await text(page, '#offsetValue'), '+100 dB');
  await page.waitForTimeout(200);
  near(parseFloat(await text(page, '#calReading')), 66, 0.3, 'reading at +100');

  await page.fill('#offset', '90.5');
  assert.equal(await text(page, '#offsetValue'), '+90.5 dB');

  await page.fill('#refDb', '65');
  await page.click('#refMatch');
  await page.waitForTimeout(200);
  assert.equal(await text(page, '#offsetValue'), '+99 dB');
  near(parseFloat(await text(page, '#calReading')), 65, 0.3, 'reading after match');

  await page.check('#teamMode');
  await page.reload();
  await page.click('.tab[data-tab="settings"]');
  assert.equal(await text(page, '#offsetValue'), '+99 dB');
  assert.equal(await page.inputValue('#offset'), '99');
  assert.equal(await page.isChecked('#teamMode'), true);
  await page.click('.tab[data-tab="game"]');
  assert.equal(await page.isChecked('#teamModeSetup'), true, 'setup toggle mirrors the setting');
  assert.equal(await text(page, '#gameMode'), 'Team');

  await page.click('.tab[data-tab="settings"]');
  await page.click('#offsetReset');
  assert.equal(await text(page, '#offsetValue'), '+94 dB');
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
  assert.equal(await text(page, '#passWindow'), '3');
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
  assert.equal(turn.win, 3);
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

test('game: team mode sends everyone back to level 1', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await startGame(page, ['Ann', 'Bob', 'Cat'], true);
  assert.equal(await text(page, '#gameMode'), 'Team');
  await playTurn(page, (t, w) => t - w / 2);
  await page.click('#nextBtn');
  await playTurn(page, (t, w) => t - w / 2);
  assert.deepEqual(await levels(page), [2, 2, 1]);
  await page.click('#nextBtn');
  await playTurn(page, (t) => t + 4);
  assert.equal(await text(page, '#resultVerdict'), 'Too loud!');
  assert.match(await text(page, '#resultLevel'), /everyone goes back to level 1/);
  assert.deepEqual(await levels(page), [1, 1, 1]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('game: loudest → softest target order steps down per level and is saved', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await page.click('.tab[data-tab="game"]');
  assert.equal(await page.isChecked('input[name="targetOrderSetup"][value="random"]'), true, 'random by default');
  await page.click('input[name="targetOrderSetup"][value="descending"]');
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
  assert.equal(await page.isChecked('input[name="targetOrder"][value="descending"]'), true);
  await page.reload();
  await page.click('.tab[data-tab="game"]');
  await page.click('#continueBtn');
  await page.waitForSelector(visible('pass'));
  assert.equal(await text(page, '#passName'), 'Bob');
  assert.equal(await text(page, '#passTargetValue'), '85');
  turn = await playTurn(page, (t, w) => t - w / 2); // Bob, level 1
  assert.equal(turn.target, 85);
  await page.click('#nextBtn');
  assert.equal(await text(page, '#passName'), 'Ann');
  assert.equal(await text(page, '#passTargetValue'), '85', 'after a miss Ann starts loud again');

  // switching back to random hides the fixed target
  await page.click('.tab[data-tab="settings"]');
  await page.click('input[name="targetOrder"][value="random"]');
  await page.click('.tab[data-tab="game"]');
  assert.equal(await page.isVisible('#passTarget'), false);
  assert.equal(await text(page, '#gameMode'), 'Solo');
  assert.deepEqual(errors, []);
  await context.close();
});

test('game: resumes after reload, windows shrink, level 10 wins', { skip }, async () => {
  const { page, context, errors } = await openApp();
  await page.evaluate(() =>
    localStorage.setItem(
      'loudEnough.game.v1',
      JSON.stringify({ v: 1, players: [{ name: 'Ann', level: 9 }, { name: 'Bob', level: 4 }], turn: 1, round: 7, winner: null, bag: [] })
    )
  );
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
  assert.equal(await page.isVisible('#resumeCard'), false, 'a finished game is not offered again');
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
  assert.ok(turn.target >= 62 + 6 + 3 + 1, 'target raised to ' + turn.target);
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
