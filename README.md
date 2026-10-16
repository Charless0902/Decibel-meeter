# Loud Enough 🎤

A mobile web app (PWA) you can add to your home screen: a **live decibel meter** plus a **party game** where you have to say a word *loud enough, but not too loud*.

Plain HTML/CSS/JS, no framework, no build step. Works on iPhone (Safari) and Android (Chrome), and offline after the first load.

> ⚠️ **Approximate meter, not a certified sound level meter.** Phone microphones differ; use the calibration offset in Settings for better accuracy.

---

## Deploy to GitHub Pages (step by step)

The microphone only works on `https://` pages. GitHub Pages gives you HTTPS for free.

1. **Make sure the files are on `main`.** If they're on another branch, open the repository on GitHub, click **Compare & pull request** → **Create pull request** → **Merge pull request**.
2. **Repository visibility.** GitHub Pages is free for **public** repositories. This repo is private, so either:
   - make it public: **Settings → General → Danger Zone → Change visibility → Public**, or
   - keep it private, which needs a paid plan (GitHub Pro, Team or Enterprise).
3. Go to **Settings → Pages**.
4. Under **Build and deployment**, set **Source: Deploy from a branch**.
5. Set **Branch: `main`** and folder **`/ (root)`**, then **Save**.
6. Wait about a minute. The **Actions** tab shows a "pages build and deployment" run; when it's green, Settings → Pages shows your link:

   **https://charless0902.github.io/Decibel-meeter/**

7. Open that link on your phone, tap **🎤 Start meter**, and allow the microphone.

**Updating later:** push changes to `main`. The app refreshes its offline copy in the background, so the new version appears the next time you open it. If you add or rename files, also add them to the `ASSETS` list in `service-worker.js` and bump `VERSION` there.

## Put it on your home screen

**iPhone / iPad (Safari)**
1. Open the GitHub Pages link in **Safari** (other iOS browsers may not offer this).
2. Tap the **Share** button (square with an arrow; on newer iOS it may be under the **⋯** menu).
3. Scroll down and tap **Add to Home Screen**, then **Add**.
4. Open **Loud Enough** from the new icon. It runs full-screen like an app.

**Android (Chrome)**
1. Open the link in **Chrome**.
2. Tap **📲 Install app** in Loud Enough's Settings (shown when Chrome offers it), or use Chrome's **⋮** menu → **Add to Home screen** / **Install app**.
3. Confirm with **Install**.

The first time you start the mic, the phone asks for microphone permission. On iPhone, home-screen apps may ask again after being closed; that's normal iOS behaviour.

## Using it

### Live meter
- Big live dB number and a gauge: **green** under 60, **yellow** 60–80, **red** over 80.
- Reference labels: 🤫 whisper ~30, 💬 conversation ~60, 📣 shouting 80+.
- Scrolling graph of the last 10 seconds; **Min / Avg / Max** with a **Reset** button (Avg is an energy average, like real meters use).
- The screen stays awake while the mic is on (where the phone supports it).

### Calibration (Settings)
Phones measure **dBFS** (relative to the loudest sound the mic can record), not real decibels. Loud Enough adds an offset (**default +105**) to show approximate **dB SPL**. (Version 1 used +94, which read about 10 dB low on an iPhone; if you never changed it, it moves to +105 automatically.)
- **🗣️ Calibrate with my voice:** hold the phone at arm's length, tap it and talk normally for 3 seconds. That level becomes 60 dB, a normal conversation.
- Have a real sound level meter? Type its reading and tap **Match**.
- Or drag the slider / use **−/+**.

### The game
1. Choose 2–10 players (names optional) and tap **Start game**.
2. Pass the phone. The player taps **I'm ready** and everyone stays quiet for **1 second** while the room noise is measured.
3. A word and a target appear (e.g. *say PICKLE at 72 dB*). Tap **GO!** and say it.
4. The app detects when you start and stop talking and records the **peak** of the word.
5. **Perfect!** if the peak is within the window just **below** the target (e.g. on Normal, level 1: target − 5 dB up to the target). Over the target is **Too loud!**, below the window is **Too quiet!**.
6. A hit moves you up a level. A miss sends you back to level 1 (and the phone vibrates, on phones that support it).
7. The window shrinks as you climb. First to **level 10** wins!

Options (on the game setup screen, and the same ones in Settings):
- **Difficulty** (the hit window for levels 1–3 / 4–6 / 7–9):

  | | Levels 1–3 | 4–6 | 7–9 |
  | --- | --- | --- | --- |
  | 😌 Easy | 8 dB | 6 dB | 4 dB |
  | 🙂 **Normal** (default) | 5 dB | 4 dB | 3 dB |
  | 😈 Hard | 3 dB | 2 dB | 1 dB |

- **Target order:**
  - **🎲 Random:** any target from 50 to 85 dB.
  - **📉 Loud → soft:** level 1 aims at 85 dB, then 81, 76, 72, 68, 63, 59, 54, down to 50 dB at level 9.
  - **📈 Soft → loud:** the same ladder upwards: 50 dB at level 1 up to 85 dB at level 9.
  - On the ladders, a miss puts you back at the start (85 or 50 dB).
- **Words:** **📚 Built-in** (100 words), **✏️ My words** (type your own, one per line or separated by commas: names, inside jokes, short phrases) or **🔀 Both**. Words never repeat until the whole list has been used.
- **Team mode:** any miss sends *everyone* back to level 1.

In a noisy room, targets too quiet to tell apart from the background are raised automatically (the screen says so). A game in progress is saved, so you can continue after closing the app.

## How it works

- `getUserMedia` with `echoCancellation`, `noiseSuppression` and `autoGainControl` all **off**, so the levels aren't altered.
- The `AudioContext` is created from a button tap (required on iOS).
- An `AnalyserNode` (`getFloatTimeDomainData`, 2048 samples) is read about **20 times per second**. RMS → dBFS → + calibration offset.
- Smoothing uses the standard sound-level-meter **"Fast" time weighting** (125 ms exponential average of signal power).
- Speech detection compares each reading to the measured noise floor (start: 6 dB above it for 100 ms; end: below floor + 4 dB for 450 ms, which bridges the gaps between syllables).
- Settings are saved in `localStorage`. A service worker caches everything for offline use. The Wake Lock API keeps the screen on, and is silently skipped where unsupported.
- No audio is recorded or uploaded; everything happens on the phone.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page and all screens |
| `app.js` | Everything: audio, meter, game, settings. Pure logic is in the `Core` block at the top |
| `style.css` | Dark, mobile-first party styling |
| `manifest.json` | PWA manifest (name, icons, standalone display) |
| `service-worker.js` | Offline cache |
| `icons/` | App icons (iOS, Android, maskable, favicon) |
| `tests/` | Unit and end-to-end tests (not needed by the app) |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is |

## Run and test locally

```bash
npm install          # only installs Playwright for the tests
npm start            # http://localhost:8080/Decibel-meeter/
npm test             # unit tests + end-to-end tests in headless Chromium
```

`localhost` counts as secure, so the mic works there on a computer. For a phone you need the HTTPS GitHub Pages link.

The end-to-end tests drive the real app in headless Chromium with a simulated microphone (a tone at known volumes). They cover the meter's accuracy, zones, stats, graph and wake lock; calibration (slider, Match, voice calibration, moving old settings to the new default) and saved settings; offline loading under the GitHub Pages sub-path; and full games: perfect / too loud / too quiet / silence, team mode, both target ladders, difficulty windows, your own words, resuming, winning and noisy rooms. One test plays a WAV of known level through Chromium's fake microphone device to check the raw-audio constraints end to end.

## Notes

- iPhone: vibration isn't supported by Safari, so fails are shown on screen only. Keeping the screen awake needs iOS 16.4+, and from the home screen it only works on recent iOS versions (older ones just let the screen dim as usual).
- Readings depend on the phone's microphone and case, and they top out where the mic clips (often 100–120 dB SPL).
