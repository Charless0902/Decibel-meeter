/*
 * Loud Enough: live decibel meter + "say it at the right volume" party game.
 *
 * Plain JavaScript, no build step. The pure logic lives in `Core` (no DOM), so
 * the same file can be loaded by Node for unit tests: require('./app.js').
 * Everything after the Core block is the browser app.
 */
(function (root) {
  'use strict';

  const VERSION = '1.3.1';

  /* =====================================================================
   * Core: pure, testable logic
   * =================================================================== */
  const Core = (function () {
    // dBFS + offset = approximate dB SPL. Version 1 used +94, which read about
    // 10 dB low on an iPhone (normal talking showed 40–54 instead of ~60).
    const DEFAULT_OFFSET = 105;
    const OLD_DEFAULT_OFFSET = 94;
    const SETTINGS_VERSION = 2;
    const TALK_DB = 60; // normal conversation, used by "calibrate with my voice"
    const OFFSET_MIN = 40;
    const OFFSET_MAX = 140;
    const METER_MIN = 20; // range of the gauge and the graph, in dB
    const METER_MAX = 120;
    const FAST_TAU = 0.125; // "Fast" time weighting (seconds), as on real meters
    const SILENCE_DB = -200; // what digital silence reports, in dBFS
    const FRAME_MS = 50; // ~20 updates per second

    const TARGET_ORDERS = ['random', 'descending', 'ascending'];

    // How far under the target a hit may land, for levels 1–3, 4–6 and 7–9.
    const DIFFICULTIES = {
      easy: [8, 6, 4],
      normal: [5, 4, 3],
      hard: [3, 2, 1],
    };

    // Team battle: every team climbs the same ladder of limits, from 50 up to
    // 115 dB, one step per player (the bigger team sets the number of steps, so
    // more players means smaller jumps). Closest to each limit without going
    // over wins that limit. Going over is a strike; three strikes lose the game.
    // Two teams play best of three.
    const TEAM = { start: 50, end: 115, maxTeams: 2, minPlayers: 1, maxPlayers: 10, sweetSpot: 3, strikes: 3, bestOf: 3 };

    const WORD_SOURCES = ['builtin', 'custom', 'both'];
    const CUSTOM_WORDS = { maxWords: 300, maxLength: 24, maxText: 6000 };

    const GAME = {
      minPlayers: 2,
      maxPlayers: 10,
      minTarget: 50,
      maxTarget: 85,
      winLevel: 10,
      floorMs: 1000, // silence measured before each turn
      settleMs: 150, // skipped first, so the "I'm ready" tap isn't measured
    };

    // Word detection. Levels are relative to the noise floor measured before the turn.
    const VAD = {
      graceMs: 250, // ignore the GO tap itself
      onMargin: 6, // dB above the floor that counts as speech
      offMargin: 4, // dB above the floor below which speech has stopped (hysteresis)
      onFrames: 2, // consecutive loud frames needed to start (~100 ms, so clicks don't count)
      hangMs: 450, // this much quiet ends the word (bridges gaps between syllables)
      noSpeechMs: 6000, // give up when nothing is heard
      maxSpeechMs: 4000, // one word never takes longer than this
    };

    const WORDS = [
      'Banana', 'Pickle', 'Noodle', 'Pizza', 'Taco', 'Waffle', 'Pancake', 'Muffin', 'Cookie', 'Donut',
      'Popcorn', 'Cupcake', 'Pretzel', 'Nacho', 'Potato', 'Coconut', 'Pineapple', 'Avocado', 'Burrito', 'Spaghetti',
      'Meatball', 'Marshmallow', 'Broccoli', 'Cheese', 'Jelly', 'Penguin', 'Panda', 'Giraffe', 'Kangaroo', 'Llama',
      'Octopus', 'Dolphin', 'Unicorn', 'Dinosaur', 'Monkey', 'Hippo', 'Koala', 'Flamingo', 'Chicken', 'Turtle',
      'Hamster', 'Puppy', 'Kitten', 'Walrus', 'Zebra', 'Moose', 'Rocket', 'Robot', 'Pirate', 'Ninja',
      'Wizard', 'Dragon', 'Zombie', 'Superhero', 'Disco', 'Banjo', 'Ukulele', 'Kazoo', 'Trumpet', 'Tuba',
      'Karaoke', 'Yodel', 'Boogie', 'Tornado', 'Volcano', 'Rainbow', 'Thunder', 'Snowman', 'Igloo', 'Jungle',
      'Bubble', 'Giggle', 'Wiggle', 'Wobble', 'Tickle', 'Hiccup', 'Sneeze', 'Squeak', 'Kaboom', 'Boing',
      'Zoom', 'Bonkers', 'Doodle', 'Gobble', 'Jiggle', 'Bamboozle', 'Fiesta', 'Party', 'Confetti', 'Balloon',
      'Sparkle', 'Glitter', 'Jackpot', 'Bingo', 'Yippee', 'Hooray', 'Whoopee', 'Abracadabra', 'Cowabunga', 'Lollipop',
    ];

    function clamp(v, lo, hi) {
      return Math.min(hi, Math.max(lo, v));
    }

    function round1(v) {
      return Math.round(v * 10) / 10;
    }

    // Average of the squared samples (signal power).
    function meanSquare(samples) {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      return samples.length ? sum / samples.length : 0;
    }

    function rms(samples) {
      return Math.sqrt(meanSquare(samples));
    }

    // Power -> dBFS. A full-scale square wave is 0 dBFS, a full-scale sine -3 dBFS.
    function powerToDb(power) {
      return power > 1e-20 ? 10 * Math.log10(power) : SILENCE_DB;
    }

    function rmsToDb(value) {
      return powerToDb(value * value);
    }

    function dbToPower(db) {
      return Math.pow(10, db / 10);
    }

    // Exponential averaging of power: the "Fast" time weighting of a sound level
    // meter. Steady enough to read, quick enough to follow speech.
    class Smoother {
      constructor(tau) {
        this.tau = tau || FAST_TAU;
        this.power = null;
      }
      push(power, dtSec) {
        if (this.power === null) {
          this.power = power;
        } else {
          const alpha = 1 - Math.exp(-Math.max(0, dtSec) / this.tau);
          this.power += (power - this.power) * alpha;
        }
        return this.power;
      }
      reset() {
        this.power = null;
      }
    }

    // Min / max / average. The average is an energy average (Leq), which is how
    // sound level meters average decibels.
    class Stats {
      constructor() {
        this.reset();
      }
      reset() {
        this.min = null;
        this.max = null;
        this.sumPower = 0;
        this.count = 0;
      }
      add(db) {
        if (!isFinite(db)) return;
        this.min = this.min === null ? db : Math.min(this.min, db);
        this.max = this.max === null ? db : Math.max(this.max, db);
        this.sumPower += dbToPower(db);
        this.count++;
      }
      get avg() {
        return this.count ? powerToDb(this.sumPower / this.count) : null;
      }
    }

    // Green under 60, yellow 60–80, red over 80.
    function zoneOf(db) {
      if (db < 60) return 'green';
      if (db <= 80) return 'yellow';
      return 'red';
    }

    function median(values) {
      if (!values.length) return SILENCE_DB;
      const sorted = values.slice().sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    // Level of normal talking in a few seconds of readings: the energy average
    // of the frames clearly above the quietest ones (pauses between words).
    // Returns null when there was no clear talking.
    function speechLevel(levels) {
      if (levels.length < 10) return null;
      const sorted = levels.slice().sort((a, b) => a - b);
      const quiet = sorted[Math.floor(sorted.length * 0.1)];
      const loudest = sorted[sorted.length - 1];
      if (loudest <= SILENCE_DB || loudest - quiet < 6) return null;
      const speech = levels.filter((v) => v > quiet + 6);
      if (speech.length < levels.length * 0.2) return null;
      let sum = 0;
      speech.forEach((v) => {
        sum += dbToPower(v);
      });
      return powerToDb(sum / speech.length);
    }

    // How far under the target a hit may land; it shrinks as you level up.
    function windowForLevel(level, difficulty) {
      const w = DIFFICULTIES[difficulty] || DIFFICULTIES.normal;
      if (level <= 3) return w[0];
      if (level <= 6) return w[1];
      return w[2];
    }

    // Success = peak between (target - window) and target, inclusive. The peak is
    // judged at the same 0.1 dB precision it is shown with.
    function judge(peak, target, win) {
      const p = round1(peak);
      if (p > target) return 'loud';
      if (p < target - win) return 'quiet';
      return 'perfect';
    }

    // Targets are 50–85 dB, but the whole success window has to sit above the
    // speech-detection threshold, so a noisy room raises the lowest target.
    function targetRange(floorDb, win) {
      let lo = GAME.minTarget;
      if (isFinite(floorDb)) lo = Math.max(lo, Math.ceil(floorDb + VAD.onMargin + win + 1));
      lo = Math.min(lo, GAME.maxTarget);
      return { lo: lo, hi: GAME.maxTarget, raised: lo > GAME.minTarget };
    }

    function pickTarget(floorDb, win, rand) {
      const range = targetRange(floorDb, win);
      const r = (rand || Math.random)();
      return Math.min(range.hi, range.lo + Math.floor(r * (range.hi - range.lo + 1)));
    }

    // Fixed target orders. "Loudest → softest": level 1 aims at 85 dB and every
    // level is a step softer, down to 50 dB at level 9 (85, 81, 76, 72, 68, 63,
    // 59, 54, 50). "Softest → loudest" is the same ladder the other way up.
    // Returns null for random targets.
    function plannedTarget(level, order) {
      if (order !== 'descending' && order !== 'ascending') return null;
      const last = GAME.winLevel - 1;
      let frac = (clamp(level, 1, last) - 1) / (last - 1);
      if (order === 'descending') frac = 1 - frac;
      return Math.round(GAME.minTarget + frac * (GAME.maxTarget - GAME.minTarget));
    }

    // The target for a turn. opts: { order, difficulty, floor (room noise in dB), rand }
    function targetFor(level, opts) {
      const o = opts || {};
      const win = windowForLevel(level, o.difficulty);
      const range = targetRange(o.floor, win);
      const planned = plannedTarget(level, o.order);
      if (planned !== null) {
        const target = clamp(planned, range.lo, range.hi);
        return { target: target, win: win, raised: target > planned };
      }
      return { target: pickTarget(o.floor, win, o.rand), win: win, raised: range.raised };
    }

    // Finds one spoken word in a stream of ~20 Hz frames and records its peak.
    // push(t, rawDb, fastDb) returns null until the word is over, then
    // { heard, peak, start, end }. `raw` drives detection (reacts instantly),
    // `fast` is the smoothed level the peak is taken from (what the bar shows).
    class WordDetector {
      constructor(floorDb, options) {
        this.o = Object.assign({}, VAD, options || {});
        this.floor = isFinite(floorDb) ? floorDb : SILENCE_DB;
        this.t0 = null;
        this.started = false;
        this.run = 0;
        this.runStart = null;
        this.runPeak = -Infinity;
        this.peak = -Infinity;
        this.maxSeen = -Infinity;
        this.speechStart = null;
        this.quietSince = null;
        this.result = null;
      }
      push(t, raw, fast) {
        if (this.result) return this.result;
        if (this.t0 === null) this.t0 = t;
        const elapsed = t - this.t0;
        if (elapsed < this.o.graceMs) return null;
        this.maxSeen = Math.max(this.maxSeen, fast);

        if (!this.started) {
          if (raw > this.floor + this.o.onMargin) {
            if (this.run === 0) {
              this.runStart = t;
              this.runPeak = -Infinity;
            }
            this.run++;
            this.runPeak = Math.max(this.runPeak, fast);
            if (this.run >= this.o.onFrames) {
              this.started = true;
              this.speechStart = this.runStart;
              this.peak = this.runPeak;
            }
          } else {
            this.run = 0;
          }
          if (!this.started && elapsed >= this.o.noSpeechMs) return this.finish(t, false);
          return null;
        }

        this.peak = Math.max(this.peak, fast);
        if (raw < this.floor + this.o.offMargin) {
          if (this.quietSince === null) this.quietSince = t;
          if (t - this.quietSince >= this.o.hangMs) return this.finish(t, true);
        } else {
          this.quietSince = null;
        }
        if (t - this.speechStart >= this.o.maxSpeechMs) return this.finish(t, true);
        return null;
      }
      finish(t, heard) {
        this.result = {
          heard: heard,
          peak: heard ? this.peak : this.maxSeen,
          start: this.speechStart,
          end: heard ? (this.quietSince !== null ? this.quietSince : t) : null,
        };
        return this.result;
      }
    }

    function cleanName(name, index) {
      const n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 16);
      return n || 'Player ' + (index + 1);
    }

    function newGame(count, names) {
      const n = clamp(Math.round(Number(count) || 0), GAME.minPlayers, GAME.maxPlayers);
      const players = [];
      for (let i = 0; i < n; i++) players.push({ name: cleanName(names && names[i], i), level: 1 });
      return { v: 1, mode: 'solo', players: players, turn: 0, round: 1, winner: null, bag: [] };
    }

    function shuffle(list, rand) {
      const a = list.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor((rand || Math.random)() * (i + 1));
        const tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
      }
      return a;
    }

    // Your own words: one per line, or separated by commas. Trimmed, de-duplicated
    // (ignoring case) and capped in length and number.
    function parseWords(text) {
      const seen = new Set();
      const out = [];
      String(text || '')
        .split(/[\n,;]+/)
        .forEach((part) => {
          const word = part.replace(/\s+/g, ' ').trim().slice(0, CUSTOM_WORDS.maxLength).trim();
          const key = word.toLowerCase();
          if (!word || seen.has(key) || out.length >= CUSTOM_WORDS.maxWords) return;
          seen.add(key);
          out.push(word);
        });
      return out;
    }

    // The words a game draws from. "My words" with an empty list falls back to
    // the built-in words, so there is always something to say.
    function wordList(settings) {
      const mine = parseWords(settings && settings.customWords);
      const source = settings && settings.wordSource;
      if (source === 'custom' && mine.length) return mine;
      if (source === 'both' && mine.length) {
        const builtIn = new Set(WORDS.map((w) => w.toLowerCase()));
        return WORDS.concat(mine.filter((w) => !builtIn.has(w.toLowerCase())));
      }
      return WORDS.slice();
    }

    // Words come from a shuffled bag, so none repeats until the whole list was
    // used, and the same word never comes twice in a row.
    function drawWord(game, words, rand) {
      const list = words && words.length ? words : WORDS;
      const allowed = new Set(list);
      let bag = Array.isArray(game.bag) ? game.bag.filter((w) => allowed.has(w)) : [];
      if (!bag.length) {
        bag = shuffle(list, rand);
        if (bag.length > 1 && bag[bag.length - 1] === game.lastWord) {
          bag.unshift(bag.pop());
        }
      }
      const word = bag.pop();
      game.bag = bag;
      game.lastWord = word;
      return word;
    }

    // Solo game: updates levels after a turn and moves on to the next player.
    function applyOutcome(game, outcome) {
      const index = game.turn;
      const player = game.players[index];
      const before = player.level;
      let reset = 'none';
      let won = false;
      if (outcome === 'perfect') {
        player.level = Math.min(GAME.winLevel, before + 1);
        won = player.level >= GAME.winLevel;
        if (won) game.winner = index;
      } else {
        player.level = 1;
        reset = 'player';
      }
      if (!won) {
        game.turn = (index + 1) % game.players.length;
        if (game.turn === 0) game.round += 1;
      }
      return { index: index, before: before, after: player.level, reset: reset, won: won };
    }

    /* ---- team battle ---- */

    // The limits, from 50 to 115 dB in even steps (rounded to 5 dB).
    function teamLadder(steps) {
      const n = clamp(Math.round(Number(steps) || 0), 2, TEAM.maxPlayers);
      const ladder = [];
      for (let i = 0; i < n; i++) {
        const exact = TEAM.start + ((TEAM.end - TEAM.start) * i) / (n - 1);
        ladder.push(i === 0 || i === n - 1 ? Math.round(exact) : Math.round(exact / 5) * 5);
      }
      return ladder;
    }

    function cleanTeamName(name, index) {
      const n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 16);
      return n || 'Team ' + (index + 1);
    }

    // teams: [{ name, count, names }], one or two of them.
    // Two teams play a best-of-three match; a single team plays one game.
    // opts.steps: ladder size when it must match a team on another phone.
    function newBattle(teams, opts) {
      const defs = (Array.isArray(teams) && teams.length ? teams : [{}]).slice(0, TEAM.maxTeams);
      const list = defs.map((t, i) => {
        const def = t || {};
        const count = clamp(Math.round(Number(def.count) || 0), TEAM.minPlayers, TEAM.maxPlayers);
        const players = [];
        for (let p = 0; p < count; p++) players.push(cleanName(def.names && def.names[p], p));
        return { name: cleanTeamName(def.name, i), players: players, scores: [], strikes: 0, done: false, out: false };
      });
      const biggest = Math.max.apply(null, list.map((t) => t.players.length));
      const ladder = teamLadder(Math.max(biggest, Math.round(Number(opts && opts.steps) || 0)));
      list.forEach((t) => {
        t.scores = ladder.map(() => null);
      });
      return {
        v: 2,
        mode: 'team',
        teams: list,
        ladder: ladder,
        bestOf: TEAM.bestOf,
        gameNo: 1,
        starter: 0, // the team that started this game (it alternates)
        current: 0,
        step: 0,
        word: null, // one word per game, the same for both teams
        wins: list.map(() => 0),
        history: [],
        gameOver: false, // this game is decided
        finished: false, // the whole match is over
        bag: [],
        lastWord: null,
      };
    }

    function winsNeeded(game) {
      return Math.floor(game.bestOf / 2) + 1;
    }

    // Who says the word now. A smaller team's players take extra turns.
    function battlePlayer(game) {
      const team = game.teams[game.current];
      return team.players[game.step % team.players.length];
    }

    // Speech detection for a limit close to the room noise: the start margin
    // shrinks from 6 dB down to 3 dB so a soft limit like 50 dB can still be
    // heard. tooNoisy: even then, anything we can hear would be over the limit.
    function battleMargins(floorDb, limit) {
      const room = isFinite(floorDb) ? limit - floorDb : Infinity;
      const on = clamp(Math.floor(room - 1), 3, VAD.onMargin);
      return { onMargin: on, offMargin: Math.max(1, on - 2), tooNoisy: isFinite(floorDb) && floorDb + on >= limit };
    }

    // Who won a game that is over: a team that struck out loses it; otherwise
    // the per-limit comparison decides.
    function decideGame(game) {
      const out = game.teams.findIndex((t) => t.out);
      if (game.teams.length === 1) return { winner: null, reason: out === 0 ? 'out' : 'done', out: out === -1 ? null : out };
      if (out !== -1) return { winner: 1 - out, reason: 'strikes', out: out };
      const cmp = compareBattle(game);
      return { winner: cmp.winner, reason: cmp.reason, out: null, wins: cmp.wins, under: cmp.under };
    }

    // Applies one turn of the team battle. res = { heard, peak }. kind:
    // 'saved' — under the limit: score kept, next player, same word.
    // 'bust'  — over the limit: a strike; back to step 1 with the same word.
    // 'out'   — third strike: this team loses the game.
    // 'retry' — nothing heard: same player tries again.
    // Also sets nextTeam (hand-over), gameOver + result, and finished (match over).
    function applyBattle(game, res) {
      const team = game.teams[game.current];
      const info = { team: game.current, step: game.step, limit: game.ladder[game.step], player: battlePlayer(game), gameNo: game.gameNo };
      if (game.gameOver) {
        info.kind = 'ignored';
        return info;
      }
      if (!res || !res.heard) {
        info.kind = 'retry';
        return info;
      }
      const score = Math.max(0, round1(res.peak));
      info.score = score;
      if (score > info.limit) {
        team.strikes += 1;
        info.strikes = team.strikes;
        team.scores = game.ladder.map(() => null);
        game.step = 0;
        if (team.strikes < TEAM.strikes) {
          info.kind = 'bust';
          return info;
        }
        info.kind = 'out';
        team.out = true;
      } else {
        info.kind = 'saved';
        team.scores[game.step] = score;
        if (game.step + 1 < game.ladder.length) {
          game.step += 1;
          return info;
        }
        team.done = true;
        info.teamDone = true;
      }
      // This team's turn is over. Hand over if the other team still has to play.
      const waiting = game.teams.findIndex((t) => !t.done && !t.out);
      if (!team.out && waiting !== -1) {
        game.current = waiting;
        game.step = 0;
        info.nextTeam = waiting;
        return info;
      }
      const result = decideGame(game);
      game.history.push({ gameNo: game.gameNo, winner: result.winner, reason: result.reason, out: result.out, word: game.word, wins: result.wins || null, under: result.under || null });
      game.gameOver = true;
      info.gameOver = true;
      info.result = result;
      if (result.winner !== null) game.wins[result.winner] += 1;
      if (game.teams.length === 1 || (result.winner !== null && game.wins[result.winner] >= winsNeeded(game))) {
        game.finished = true;
        info.finished = true;
      }
      return info;
    }

    // Starts the next game of the match: fresh ladder, new word, and the other
    // team starts (game 1: team 1, game 2: team 2, game 3: team 1).
    function nextGame(game) {
      if (!game.gameOver || game.finished) return false;
      game.gameNo += 1;
      game.starter = game.teams.length === 2 ? (game.gameNo - 1) % 2 : 0;
      game.current = game.starter;
      game.step = 0;
      game.word = null;
      game.gameOver = false;
      game.teams.forEach((t) => {
        t.scores = game.ladder.map(() => null);
        t.strikes = 0;
        t.done = false;
        t.out = false;
      });
      return true;
    }

    // The match winner, once someone has won enough games.
    function matchWinner(game) {
      const need = winsNeeded(game);
      const i = game.wins.findIndex((w) => w >= need);
      return i === -1 ? null : i;
    }

    // Per limit, the higher score (closer without going over) wins it. Most
    // limits wins; if that's level, the team closest overall wins.
    function compareBattle(game) {
      const two = game.teams.length === 2;
      const rows = game.ladder.map((limit, i) => {
        const scores = game.teams.map((t) => t.scores[i]);
        let winner = null;
        if (two && scores[0] !== null && scores[1] !== null && scores[0] !== scores[1]) winner = scores[0] > scores[1] ? 0 : 1;
        return { limit: limit, scores: scores, winner: winner };
      });
      const wins = game.teams.map((_, ti) => rows.filter((r) => r.winner === ti).length);
      const under = game.teams.map((t) =>
        round1(game.ladder.reduce((sum, limit, i) => sum + (t.scores[i] === null ? 0 : limit - t.scores[i]), 0))
      );
      let winner = null;
      let reason = null;
      if (two && game.teams.every((t) => t.done)) {
        if (wins[0] !== wins[1]) {
          winner = wins[0] > wins[1] ? 0 : 1;
          reason = 'limits';
        } else if (under[0] !== under[1]) {
          winner = under[0] < under[1] ? 0 : 1;
          reason = 'closer';
        } else {
          reason = 'tie';
        }
      }
      return { rows: rows, wins: wins, under: under, winner: winner, reason: reason };
    }

    // How good a score is, by how far under the limit it landed.
    function rateCloseness(under) {
      if (under <= 1) return 'amazing';
      if (under <= 3) return 'great';
      if (under <= 6) return 'nice';
      return 'safe';
    }

    function isGameOver(game) {
      return game.mode === 'team' ? game.finished === true : game.winner !== null;
    }

    function sanitizeSettings(raw) {
      const s = {
        v: SETTINGS_VERSION,
        offset: DEFAULT_OFFSET,
        targetOrder: 'random',
        difficulty: 'normal',
        wordSource: 'builtin',
        customWords: '',
      };
      if (raw && typeof raw === 'object') {
        // Settings saved by version 1 still hold its +94 default; unless it was
        // changed by hand, move it to the new default.
        const fromV1 = !(raw.v >= 2);
        const offset = Number(raw.offset);
        if (typeof raw.offset === 'number' && isFinite(offset) && !(fromV1 && offset === OLD_DEFAULT_OFFSET)) {
          s.offset = clamp(offset, OFFSET_MIN, OFFSET_MAX);
        }
        if (TARGET_ORDERS.indexOf(raw.targetOrder) !== -1) s.targetOrder = raw.targetOrder;
        if (Object.prototype.hasOwnProperty.call(DIFFICULTIES, raw.difficulty)) s.difficulty = raw.difficulty;
        if (WORD_SOURCES.indexOf(raw.wordSource) !== -1) s.wordSource = raw.wordSource;
        if (typeof raw.customWords === 'string') s.customWords = raw.customWords.slice(0, CUSTOM_WORDS.maxText);
      }
      return s;
    }

    function sanitizeBag(raw) {
      // The bag holds the words still to come (version 1 stored indexes into WORDS).
      const bag = [];
      (Array.isArray(raw.bag) ? raw.bag : []).forEach((w) => {
        if (Number.isInteger(w) && w >= 0 && w < WORDS.length) bag.push(WORDS[w]);
        else if (typeof w === 'string' && w && w.length <= CUSTOM_WORDS.maxLength) bag.push(w);
      });
      return bag;
    }

    const RESULT_REASONS = ['limits', 'closer', 'tie', 'strikes', 'out', 'done'];

    function sanitizeBattle(raw) {
      if (raw.v !== 2) return null; // battles saved by an older version are dropped
      if (!Array.isArray(raw.teams) || raw.teams.length < 1 || raw.teams.length > TEAM.maxTeams) return null;
      const n = raw.teams.length;
      const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
      const teams = [];
      for (let i = 0; i < n; i++) {
        const t = raw.teams[i];
        if (!t || typeof t !== 'object' || !Array.isArray(t.players)) return null;
        if (t.players.length < TEAM.minPlayers || t.players.length > TEAM.maxPlayers) return null;
        if (!int(t.strikes, 0, TEAM.strikes)) return null;
        teams.push({
          name: cleanTeamName(t.name, i),
          players: t.players.map((p, j) => cleanName(p, j)),
          scores: t.scores,
          strikes: t.strikes,
          done: t.done === true,
          out: t.out === true,
        });
      }
      const biggest = Math.max.apply(null, teams.map((t) => t.players.length));
      const size = Array.isArray(raw.ladder) ? raw.ladder.length : 0;
      if (size < Math.max(2, biggest) || size > TEAM.maxPlayers) return null;
      const ladder = teamLadder(size);
      if (ladder.some((v, i) => raw.ladder[i] !== v)) return null;
      for (const t of teams) {
        if (!Array.isArray(t.scores) || t.scores.length !== ladder.length) return null;
        for (let i = 0; i < ladder.length; i++) {
          const v = t.scores[i];
          if (v !== null && !(typeof v === 'number' && isFinite(v) && v >= 0 && v <= ladder[i])) return null;
        }
        if (t.done && t.scores.some((v) => v === null)) return null;
        if (t.out !== (t.strikes >= TEAM.strikes)) return null;
      }
      const bestOf = TEAM.bestOf;
      const need = Math.floor(bestOf / 2) + 1;
      if (!int(raw.current, 0, n - 1) || !int(raw.starter, 0, n - 1)) return null;
      if (!int(raw.step, 0, ladder.length - 1)) return null;
      if (!int(raw.gameNo, 1, 99)) return null;
      if (!Array.isArray(raw.wins) || raw.wins.length !== n || !raw.wins.every((w) => int(w, 0, need))) return null;
      if (!Array.isArray(raw.history)) return null;
      const history = [];
      for (const h of raw.history) {
        if (!h || typeof h !== 'object' || RESULT_REASONS.indexOf(h.reason) === -1) return null;
        if (h.winner !== null && !int(h.winner, 0, n - 1)) return null;
        const nums = (a) => (Array.isArray(a) && a.length === n && a.every((x) => typeof x === 'number' && isFinite(x)) ? a.slice() : null);
        history.push({
          gameNo: int(h.gameNo, 1, 99) ? h.gameNo : history.length + 1,
          winner: h.winner,
          reason: h.reason,
          out: h.out !== null && int(h.out, 0, n - 1) ? h.out : null,
          word: typeof h.word === 'string' ? h.word.slice(0, CUSTOM_WORDS.maxLength) : null,
          wins: nums(h.wins),
          under: nums(h.under),
        });
      }
      const gameOver = raw.gameOver === true;
      const finished = raw.finished === true;
      if (finished && !gameOver) return null;
      return {
        v: 2,
        mode: 'team',
        teams: teams,
        ladder: ladder,
        bestOf: bestOf,
        gameNo: raw.gameNo,
        starter: raw.starter,
        current: raw.current,
        step: raw.step,
        word: typeof raw.word === 'string' && raw.word && raw.word.length <= CUSTOM_WORDS.maxLength ? raw.word : null,
        wins: raw.wins.slice(),
        history: history,
        gameOver: gameOver,
        finished: finished,
        bag: sanitizeBag(raw),
        lastWord: typeof raw.lastWord === 'string' ? raw.lastWord : null,
      };
    }

    // Validates a saved game from storage; anything odd means "no saved game".
    function sanitizeGame(raw) {
      if (!raw || typeof raw !== 'object') return null;
      if (raw.mode === 'team') return sanitizeBattle(raw);
      if (!Array.isArray(raw.players)) return null;
      const n = raw.players.length;
      if (n < GAME.minPlayers || n > GAME.maxPlayers) return null;
      const players = [];
      for (let i = 0; i < n; i++) {
        const p = raw.players[i];
        if (!p || typeof p !== 'object') return null;
        if (!Number.isInteger(p.level) || p.level < 1 || p.level > GAME.winLevel) return null;
        players.push({ name: cleanName(p.name, i), level: p.level });
      }
      if (!Number.isInteger(raw.turn) || raw.turn < 0 || raw.turn >= n) return null;
      let winner = null;
      if (raw.winner !== null && raw.winner !== undefined) {
        if (!Number.isInteger(raw.winner) || raw.winner < 0 || raw.winner >= n) return null;
        winner = raw.winner;
      }
      const round = Number.isInteger(raw.round) && raw.round > 0 ? raw.round : 1;
      const lastWord = typeof raw.lastWord === 'string' ? raw.lastWord : null;
      return { v: 1, mode: 'solo', players: players, turn: raw.turn, round: round, winner: winner, bag: sanitizeBag(raw), lastWord: lastWord };
    }

    // The game setup screen's choices (mode, teams, names), remembered between games.
    function sanitizeSetup(raw) {
      const r = raw && typeof raw === 'object' ? raw : {};
      const roster = (x, min, max) => {
        const o = x && typeof x === 'object' ? x : {};
        return {
          count: Number.isInteger(o.count) ? clamp(o.count, min, max) : 3,
          names: Array.isArray(o.names) ? o.names.slice(0, max).map((n) => (typeof n === 'string' ? n.slice(0, 16) : '')) : [],
        };
      };
      const teams = [0, 1].map((i) => {
        const t = Array.isArray(r.teams) && r.teams[i] && typeof r.teams[i] === 'object' ? r.teams[i] : {};
        const ro = roster(t, TEAM.minPlayers, TEAM.maxPlayers);
        return { name: typeof t.name === 'string' ? t.name.slice(0, 16) : '', count: ro.count, names: ro.names };
      });
      return {
        mode: r.mode === 'team' ? 'team' : 'solo',
        teamCount: r.teamCount === 1 ? 1 : 2,
        solo: roster(r.solo, GAME.minPlayers, GAME.maxPlayers),
        teams: teams,
        otherCount: Number.isInteger(r.otherCount) ? clamp(r.otherCount, TEAM.minPlayers, TEAM.maxPlayers) : 3,
      };
    }

    return {
      DEFAULT_OFFSET, OFFSET_MIN, OFFSET_MAX, METER_MIN, METER_MAX, FAST_TAU, SILENCE_DB, FRAME_MS,
      OLD_DEFAULT_OFFSET, SETTINGS_VERSION, TALK_DB,
      GAME, VAD, WORDS, TARGET_ORDERS, DIFFICULTIES, WORD_SOURCES, CUSTOM_WORDS, TEAM,
      clamp, round1, meanSquare, rms, powerToDb, rmsToDb, dbToPower, Smoother, Stats, zoneOf, median, speechLevel,
      windowForLevel, judge, targetRange, pickTarget, plannedTarget, targetFor, WordDetector, cleanName, newGame, shuffle,
      parseWords, wordList, drawWord, applyOutcome, sanitizeSettings, sanitizeGame, sanitizeSetup,
      teamLadder, cleanTeamName, newBattle, battlePlayer, battleMargins, applyBattle, decideGame, nextGame, matchWinner, winsNeeded,
      compareBattle, rateCloseness, isGameOver,
    };
  })();

  if (typeof module === 'object' && module.exports) {
    module.exports = Core;
    return;
  }
  root.LoudEnoughCore = Core;
  if (typeof document === 'undefined') return;

  /* =====================================================================
   * Browser app
   * =================================================================== */
  const $ = (id) => document.getElementById(id);
  const noop = () => {};
  const isIOS =
    /iP(hone|od|ad)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () =>
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    navigator.standalone === true;
  const fmt1 = (v) => (v === null || v === undefined || !isFinite(v) ? '--' : Core.round1(v).toFixed(1));

  function emitter() {
    const fns = new Set();
    return {
      on(fn) {
        fns.add(fn);
        return () => fns.delete(fn);
      },
      emit(value) {
        fns.forEach((fn) => {
          try {
            fn(value);
          } catch (e) {
            console.error(e);
          }
        });
      },
    };
  }

  function buzz(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) {
      /* not supported (e.g. iPhone) */
    }
  }

  /* ---------- storage ---------- */
  const KEYS = {
    settings: 'loudEnough.settings.v1',
    game: 'loudEnough.game.v1',
    setup: 'loudEnough.setup.v1',
    tip: 'loudEnough.installTipDismissed.v1',
  };
  const store = {
    get(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        /* private mode or full: keep going without saving */
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        /* ignore */
      }
    },
  };

  const settings = Core.sanitizeSettings(store.get(KEYS.settings));
  const settingsChanged = emitter();
  function saveSettings() {
    store.set(KEYS.settings, settings);
    settingsChanged.emit(settings);
  }
  // Mic levels are kept in dBFS; the calibration offset is applied on display.
  const spl = (dbfs) => dbfs + settings.offset;

  /* ---------- toast ---------- */
  let toastTimer = 0;
  function toast(message, ms) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    // restart the slide-in animation
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      el.hidden = true;
    }, ms || 3500);
  }

  /* =====================================================================
   * Screen wake lock (keeps the screen on while the mic is on)
   * =================================================================== */
  const WakeLock = {
    sentinel: null,
    wanted: false,
    pending: false,
    acquire() {
      this.wanted = true;
      if (!('wakeLock' in navigator) || this.sentinel || this.pending) return;
      if (document.visibilityState !== 'visible') return;
      this.pending = true;
      Promise.resolve()
        .then(() => navigator.wakeLock.request('screen'))
        .then((sentinel) => {
          this.pending = false;
          if (!this.wanted) {
            sentinel.release().catch(noop);
            return;
          }
          this.sentinel = sentinel;
          sentinel.addEventListener('release', () => {
            if (this.sentinel === sentinel) this.sentinel = null;
          });
        })
        .catch(() => {
          this.pending = false; // unsupported or refused: fail silently
        });
    },
    release() {
      this.wanted = false;
      const s = this.sentinel;
      this.sentinel = null;
      if (s) {
        try {
          s.release().catch(noop);
        } catch (e) {
          /* ignore */
        }
      }
    },
  };

  /* =====================================================================
   * Microphone + level measurement
   * =================================================================== */
  const MIC_MESSAGES = {
    insecure: 'The microphone only works on a secure (https://) page. Open Loud Enough from its GitHub Pages link.',
    unsupported: "This browser can't measure sound. Try Safari on iPhone or Chrome on Android.",
    denied: isIOS
      ? 'Microphone access is blocked. Allow it in Settings › Safari (or Settings › Apps › Safari) › Microphone, then try again.'
      : 'Microphone access is blocked. Allow the microphone for this site (tap the icon next to the address), then try again.',
    missing: 'No microphone was found on this device.',
    busy: 'The microphone is busy (a call or another app?). Close it and try again.',
    aborted: 'Microphone start was cancelled.',
    other: "Couldn't start the microphone.",
  };

  function micError(code, detail) {
    const e = new Error(MIC_MESSAGES[code] + (detail ? ' (' + detail + ')' : ''));
    e.code = code;
    return e;
  }

  function normalizeMicError(e) {
    if (e && e.code && MIC_MESSAGES[e.code]) return e;
    const name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return micError('denied');
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return micError('missing');
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return micError('busy');
    return micError('other', e && e.message);
  }

  // Raw levels: no echo cancellation, noise suppression or automatic gain.
  const AUDIO_CONSTRAINTS = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  const Mic = {
    state: 'off', // off | starting | on | paused (needs a tap to come back)
    ctx: null,
    stream: null,
    analyser: null,
    nodes: [],
    timer: 0,
    floatBuf: null,
    byteBuf: null,
    smoother: new Core.Smoother(Core.FAST_TAU),
    lastT: 0,
    startedAt: 0,
    pending: null,
    last: null, // latest frame
    frames: emitter(),
    changes: emitter(),

    setState(state) {
      if (this.state === state) return;
      this.state = state;
      this.changes.emit(state);
    },

    // Must be called from a tap: iOS only starts audio from a user gesture.
    start() {
      if (this.state === 'on') return Promise.resolve();
      if (this.pending) return this.pending;
      if (this.state === 'paused') this.teardown();

      const md = navigator.mediaDevices;
      if (window.isSecureContext === false || !md || !md.getUserMedia) return Promise.reject(micError('insecure'));
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return Promise.reject(micError('unsupported'));

      // Create and resume the AudioContext synchronously, inside the tap, before
      // the (async) permission prompt; otherwise iOS keeps it suspended.
      let ctx;
      try {
        ctx = new AC();
      } catch (e) {
        return Promise.reject(micError('unsupported'));
      }
      this.ctx = ctx;
      if (ctx.resume) ctx.resume().catch(noop);
      this.setState('starting');

      this.pending = md
        .getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false })
        .then((stream) => {
          if (this.ctx !== ctx) {
            stream.getTracks().forEach((t) => t.stop());
            throw micError('aborted');
          }
          this.stream = stream;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 2048; // ~43 ms of audio per reading
          analyser.smoothingTimeConstant = 0;
          // Some browsers only run nodes that lead to the speakers. A muted gain
          // node keeps the graph alive without any feedback.
          const mute = ctx.createGain();
          mute.gain.value = 0;
          source.connect(analyser);
          analyser.connect(mute);
          mute.connect(ctx.destination);
          this.nodes = [source, analyser, mute];
          this.analyser = analyser;
          this.floatBuf = new Float32Array(analyser.fftSize);
          this.byteBuf = new Uint8Array(analyser.fftSize);
          stream.getAudioTracks().forEach((track) => {
            track.addEventListener('ended', () => {
              if (this.stream === stream) this.lost();
            });
          });
          ctx.onstatechange = () => this.checkContext();
          return ctx.state === 'running' ? null : ctx.resume().catch(noop);
        })
        .then(() => {
          this.smoother.reset();
          this.lastT = 0;
          this.last = null;
          this.startedAt = performance.now();
          clearInterval(this.timer);
          this.timer = setInterval(() => this.tick(), Core.FRAME_MS);
          WakeLock.acquire();
          this.setState('on');
          this.checkContext();
        })
        .catch((e) => {
          if (this.ctx === ctx) {
            this.teardown();
            this.setState('off');
          }
          throw normalizeMicError(e);
        })
        .finally(() => {
          this.pending = null;
        });
      return this.pending;
    },

    stop() {
      this.teardown();
      this.setState('off');
    },

    // The mic went away by itself (track ended, context closed).
    lost() {
      if (this.state === 'off') return;
      this.teardown();
      this.setState('paused');
    },

    teardown() {
      clearInterval(this.timer);
      this.timer = 0;
      this.nodes.forEach((n) => {
        try {
          n.disconnect();
        } catch (e) {
          /* ignore */
        }
      });
      this.nodes = [];
      const stream = this.stream;
      this.stream = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      const ctx = this.ctx;
      this.ctx = null;
      if (ctx) {
        ctx.onstatechange = null;
        if (ctx.state !== 'closed' && ctx.close) ctx.close().catch(noop);
      }
      this.analyser = null;
      this.last = null;
      WakeLock.release();
    },

    checkContext() {
      if (!this.ctx || (this.state !== 'on' && this.state !== 'paused')) return;
      const s = this.ctx.state;
      if (s === 'running') {
        this.setState('on');
        WakeLock.acquire();
      } else if (s === 'closed') {
        this.lost();
      } else {
        this.setState('paused'); // "suspended", or iOS "interrupted"
      }
    },

    // Back from the background: try to resume without a tap first.
    wake() {
      if (!this.ctx || (this.state !== 'on' && this.state !== 'paused')) return;
      const live = this.stream && this.stream.getAudioTracks().some((t) => t.readyState === 'live');
      if (!live) {
        this.lost();
        return;
      }
      if (this.ctx.state !== 'running') {
        this.ctx.resume().then(() => this.checkContext(), () => this.checkContext());
      }
      this.checkContext();
    },

    tick() {
      const analyser = this.analyser;
      if (!analyser || !this.ctx || this.ctx.state !== 'running') return;
      const now = performance.now();
      const dt = this.lastT ? Math.min(1, (now - this.lastT) / 1000) : Core.FRAME_MS / 1000;
      this.lastT = now;
      const buf = this.floatBuf;
      if (analyser.getFloatTimeDomainData) {
        analyser.getFloatTimeDomainData(buf);
      } else {
        analyser.getByteTimeDomainData(this.byteBuf);
        for (let i = 0; i < buf.length; i++) buf[i] = (this.byteBuf[i] - 128) / 128;
      }
      const power = Core.meanSquare(buf);
      const fastPower = this.smoother.push(power, dt);
      const frame = {
        t: now,
        rawFs: Core.powerToDb(power), // this reading only
        fastFs: Core.powerToDb(fastPower), // smoothed (Fast weighting)
        silent: power === 0,
        warm: now - this.startedAt > 300, // mics often pop for a moment at start
      };
      this.last = frame;
      this.frames.emit(frame);
    },
  };

  function showMicError(e) {
    if (!e || e.code === 'aborted') return;
    console.warn(e);
    toast(e.message, 7000);
    const el = $('meterError');
    el.textContent = e.message;
    el.hidden = false;
  }

  /* =====================================================================
   * Live meter
   * =================================================================== */
  const G = { cx: 160, cy: 172, r: 128, w: 22, min: Core.METER_MIN, max: Core.METER_MAX };
  const ZONES = [
    { cls: 'green', from: Core.METER_MIN, to: 60 },
    { cls: 'yellow', from: 60, to: 80 },
    { cls: 'red', from: 80, to: Core.METER_MAX },
  ];
  const ZONE_LABEL = { green: 'Comfortable', yellow: 'Loud', red: 'Very loud!' };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function angleOf(v) {
    return Math.PI * (1 - Core.clamp((v - G.min) / (G.max - G.min), 0, 1));
  }
  function polar(r, a) {
    return [G.cx + r * Math.cos(a), G.cy - r * Math.sin(a)];
  }
  function arcD(v0, v1, r) {
    const p0 = polar(r, angleOf(v0));
    const p1 = polar(r, angleOf(v1));
    return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) + ' A' + r + ' ' + r + ' 0 0 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
  }
  function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
    if (parent) parent.appendChild(el);
    return el;
  }

  const Meter = {
    stats: new Core.Stats(),
    history: [], // { t, fs } for the graph, last ~10 s
    shown: null, // eased value for the gauge animation
    lastDraw: 0,
    raf: 0,
    zone: null,
    levelArcs: [],
    graph: null,

    init() {
      this.buildGauge();
      $('micBtn').addEventListener('click', () => {
        $('meterError').hidden = true;
        if (Mic.state === 'on' || Mic.state === 'starting' || Mic.state === 'paused') Mic.stop();
        else Mic.start().catch(showMicError);
      });
      $('resetStats').addEventListener('click', () => {
        this.stats.reset();
        this.renderStats();
        this.renderGauge(this.shown);
      });
      Mic.frames.on((f) => this.onFrame(f));
      Mic.changes.on((s) => this.onState(s));
      settingsChanged.on(() => {
        this.renderStats();
        if (Mic.last) this.renderReadout(Mic.last);
      });
      window.addEventListener('resize', () => {
        this.sizeGraph();
        this.drawGraph(performance.now());
      });
      this.onState(Mic.state);
    },

    buildGauge() {
      const tracks = $('gaugeTracks');
      const levels = $('gaugeLevels');
      const ticks = $('gaugeTicks');
      const refs = $('gaugeRefs');
      ZONES.forEach((z) => {
        const d = arcD(z.from, z.to, G.r);
        svgEl('path', { d: d, class: 'arc-track ' + z.cls, 'stroke-width': G.w }, tracks);
        const level = svgEl('path', { d: d, class: 'arc-level ' + z.cls, 'stroke-width': G.w }, levels);
        const len = G.r * Math.PI * (z.to - z.from) / (G.max - G.min);
        level.style.strokeDasharray = '0 ' + (len + 1);
        this.levelArcs.push({ el: level, from: z.from, to: z.to, len: len, last: -1 });
      });
      const inner = G.r - G.w / 2;
      for (let v = G.min; v <= G.max; v += 5) {
        const a = angleOf(v);
        const major = v % 10 === 0;
        const p0 = polar(inner - 3, a);
        const p1 = polar(inner - (major ? 11 : 6), a);
        svgEl('line', { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], class: major ? 'tick major' : 'tick' }, ticks);
        if (v === G.min || v === 60 || v === 80 || v === G.max) {
          const p = polar(inner - 24, a);
          const t = svgEl('text', { x: p[0], y: p[1] + 4, class: 'tick-label' }, ticks);
          t.textContent = v;
        }
      }
      [
        { v: 30, emoji: '🤫' },
        { v: 60, emoji: '💬' },
        { v: 80, emoji: '📣' },
      ].forEach((ref) => {
        const a = angleOf(ref.v);
        const p0 = polar(G.r - G.w / 2 - 1, a);
        const p1 = polar(G.r + G.w / 2 + 1, a);
        svgEl('line', { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], class: 'ref-line' }, refs);
        const p = polar(G.r + G.w / 2 + 15, a);
        const t = svgEl('text', { x: p[0], y: p[1] + 6, class: 'ref-emoji-svg' }, refs);
        t.textContent = ref.emoji;
      });
    },

    onState(state) {
      const btn = $('micBtn');
      const on = state === 'on' || state === 'paused';
      btn.textContent = state === 'starting' ? 'Starting…' : on ? '■ Stop' : '🎤 Start meter';
      btn.classList.toggle('btn-primary', !on && state !== 'starting');
      btn.classList.toggle('btn-ghost', on || state === 'starting');
      btn.disabled = state === 'starting';
      if (state === 'on') {
        $('meterError').hidden = true;
        if (this.prevState === 'off' || this.prevState === 'starting' || this.prevState === undefined) {
          this.history = [];
          this.stats.reset();
          this.renderStats();
        }
        this.loop();
      }
      if (state === 'off') {
        this.shown = null;
        this.zone = null;
        $('dbInt').textContent = '--';
        $('dbDec').textContent = '';
        $('readout').dataset.zone = 'off';
        $('zoneLabel').textContent = 'Mic is off';
        document.querySelectorAll('#refChips .ref').forEach((el) => el.classList.remove('active'));
        this.renderGauge(null);
        this.drawGraph(performance.now());
      }
      this.prevState = state;
    },

    onFrame(f) {
      this.history.push({ t: f.t, fs: f.fastFs });
      const cutoff = f.t - 10500;
      while (this.history.length && this.history[0].t < cutoff) this.history.shift();
      if (f.warm && !f.silent) this.stats.add(f.fastFs);
      if (activeTab === 'meter') {
        this.renderReadout(f);
        this.renderStats();
      }
    },

    renderReadout(f) {
      const v = Math.max(0, spl(f.fastFs));
      const parts = Core.round1(v).toFixed(1).split('.');
      $('dbInt').textContent = parts[0];
      $('dbDec').textContent = '.' + parts[1];
      const zone = Core.zoneOf(v);
      if (zone !== this.zone) {
        this.zone = zone;
        $('readout').dataset.zone = zone;
        $('zoneLabel').textContent = ZONE_LABEL[zone];
      }
      const ref = v < 45 ? 'whisper' : v < 80 ? 'talk' : 'shout';
      document.querySelectorAll('#refChips .ref').forEach((el) => {
        el.classList.toggle('active', el.dataset.ref === ref);
      });
    },

    renderStats() {
      const s = this.stats;
      $('statMin').textContent = s.min === null ? '--' : fmt1(Math.max(0, spl(s.min)));
      $('statAvg').textContent = s.avg === null ? '--' : fmt1(Math.max(0, spl(s.avg)));
      $('statMax').textContent = s.max === null ? '--' : fmt1(Math.max(0, spl(s.max)));
    },

    renderGauge(v) {
      this.levelArcs.forEach((arc) => {
        const frac = v === null ? 0 : Core.clamp((v - arc.from) / (arc.to - arc.from), 0, 1);
        const vis = Math.round(frac * arc.len * 10) / 10;
        if (vis !== arc.last) {
          arc.last = vis;
          arc.el.style.strokeDasharray = vis + ' ' + (arc.len + 1);
        }
      });
      const peak = $('peakTick');
      if (this.stats.max === null) {
        peak.setAttribute('d', '');
      } else {
        const a = angleOf(spl(this.stats.max));
        const outer = G.r + G.w / 2;
        const tip = polar(outer + 1, a);
        const l = polar(outer + 9, a + 0.035);
        const r = polar(outer + 9, a - 0.035);
        peak.setAttribute('d', 'M' + tip.join(' ') + 'L' + l.join(' ') + 'L' + r.join(' ') + 'Z');
      }
    },

    loop() {
      if (this.raf) return;
      const step = (now) => {
        this.raf = 0;
        if (Mic.state !== 'on' && Mic.state !== 'paused') return;
        if (activeTab === 'meter') {
          if (Mic.last) {
            const target = Core.clamp(spl(Mic.last.fastFs), 0, 140);
            const dt = this.lastDraw ? Math.min(100, now - this.lastDraw) : 16;
            this.shown = this.shown === null ? target : this.shown + (target - this.shown) * (1 - Math.exp(-dt / 60));
          }
          this.renderGauge(this.shown);
          this.drawGraph(now);
        }
        this.lastDraw = now;
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    },

    onShow() {
      this.sizeGraph();
      this.renderStats();
      if (Mic.last && Mic.state === 'on') this.renderReadout(Mic.last);
      this.drawGraph(performance.now());
    },

    sizeGraph() {
      const c = $('graph');
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      this.graph = { ctx: c.getContext('2d'), w: w, h: h, dpr: dpr };
    },

    drawGraph(now) {
      if (!this.graph) this.sizeGraph();
      if (!this.graph) return;
      const g = this.graph;
      const ctx = g.ctx;
      const w = g.w;
      const h = g.h;
      ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const y = (v) => h - ((Core.clamp(v, G.min, G.max) - G.min) / (G.max - G.min)) * h;
      const y60 = y(60);
      const y80 = y(80);

      ctx.fillStyle = 'rgba(52, 224, 122, 0.07)';
      ctx.fillRect(0, y60, w, h - y60);
      ctx.fillStyle = 'rgba(255, 210, 63, 0.08)';
      ctx.fillRect(0, y80, w, y60 - y80);
      ctx.fillStyle = 'rgba(255, 77, 94, 0.09)';
      ctx.fillRect(0, 0, w, y80);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.font = '700 10px ui-rounded, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      [30, 60, 80, 100].forEach((v) => {
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y(v)) + 0.5);
        ctx.lineTo(w, Math.round(y(v)) + 0.5);
        ctx.stroke();
        ctx.fillText(String(v), 4, y(v) - 3);
      });
      ctx.setLineDash([]);

      const pts = this.history;
      if (pts.length < 2) return;
      const span = 10000;
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      const s80 = Core.clamp(y80 / h, 0, 1);
      const s60 = Core.clamp(y60 / h, 0, 1);
      grad.addColorStop(0, '#ff4d5e');
      grad.addColorStop(s80, '#ff4d5e');
      grad.addColorStop(s80, '#ffd23f');
      grad.addColorStop(s60, '#ffd23f');
      grad.addColorStop(s60, '#34e07a');
      grad.addColorStop(1, '#34e07a');

      ctx.beginPath();
      let first = true;
      let x0 = 0;
      let xn = 0;
      for (let i = 0; i < pts.length; i++) {
        const x = w - ((now - pts[i].t) / span) * w;
        const yy = y(spl(pts[i].fs));
        if (first) {
          ctx.moveTo(x, yy);
          x0 = x;
          first = false;
        } else {
          ctx.lineTo(x, yy);
        }
        xn = x;
      }
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.lineTo(xn, h);
      ctx.lineTo(x0, h);
      ctx.closePath();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.globalAlpha = 1;
    },
  };

  /* =====================================================================
   * Settings
   * =================================================================== */
  function fmtOffset(v) {
    return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(v % 1 ? 1 : 0) + ' dB';
  }

  const ORDER_HELP = {
    random: 'Any target from 50 to 85 dB.',
    descending: 'Level 1 aims at 85 dB, then 81, 76, 72, 68, 63, 59, 54, down to 50 dB at level 9. A miss starts you loud again.',
    ascending: 'Level 1 aims at 50 dB, then 54, 59, 63, 68, 72, 76, 81, up to 85 dB at level 9. A miss starts you soft again.',
  };
  const ORDER_ICON = { random: '', descending: '📉', ascending: '📈' };
  const ORDER_NAME = { random: 'random targets', descending: 'loudest to softest', ascending: 'softest to loudest' };

  function wordsHelp(count) {
    const plural = count === 1 ? '' : 's';
    if (!count) return 'Type at least one word or short phrase. Until then, the built-in words are used.';
    if (settings.wordSource === 'custom') return 'The game uses only your ' + count + ' word' + plural + '.';
    return 'Your ' + count + ' word' + plural + (count === 1 ? ' is' : ' are') + ' mixed in with the 100 built-in ones.';
  }

  const SettingsView = {
    calibrating: false,

    init() {
      this.initOptions();
      const slider = $('offset');
      slider.min = Core.OFFSET_MIN;
      slider.max = Core.OFFSET_MAX;
      slider.addEventListener('input', () => this.setOffset(parseFloat(slider.value)));
      $('offsetMinus').addEventListener('click', () => this.setOffset(settings.offset - 1));
      $('offsetPlus').addEventListener('click', () => this.setOffset(settings.offset + 1));
      $('offsetReset').addEventListener('click', () => this.setOffset(Core.DEFAULT_OFFSET));
      $('refMatch').addEventListener('click', () => this.matchReference());
      $('refDb').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.matchReference();
      });
      $('calMic').addEventListener('click', () => Mic.start().catch(showMicError));
      $('voiceCal').addEventListener('click', () => this.voiceCalibrate());
      Mic.frames.on((f) => {
        if (activeTab === 'settings') $('calReading').textContent = fmt1(Math.max(0, spl(f.fastFs))) + ' dB';
      });
      Mic.changes.on((s) => {
        $('calMic').hidden = s === 'on';
        if (s === 'off') $('calReading').textContent = '--';
      });
      settingsChanged.on(() => this.render());
      $('appVersion').textContent = VERSION;
      this.render();
    },

    // The game options exist twice (game setup screen and Settings), cloned from
    // one template. Every [data-setting] control writes straight to `settings`.
    initOptions() {
      const tpl = $('gameOptionsTpl');
      ['setupOptions', 'settingsOptions'].forEach((id) => {
        const box = $(id);
        box.appendChild(tpl.content.cloneNode(true));
        box.querySelectorAll('input[type="radio"]').forEach((radio) => {
          radio.name = radio.dataset.setting + '-' + id;
        });
      });
      document.querySelectorAll('[data-setting]').forEach((el) => {
        const key = el.dataset.setting;
        const choice = el.type === 'radio' || el.type === 'checkbox';
        el.addEventListener(choice ? 'change' : 'input', () => {
          if (el.type === 'radio') {
            if (!el.checked) return;
            settings[key] = el.value;
          } else if (el.type === 'checkbox') {
            settings[key] = el.checked;
          } else {
            settings[key] = el.value.slice(0, Core.CUSTOM_WORDS.maxText);
          }
          saveSettings();
        });
      });
    },

    setOffset(v) {
      if (!isFinite(v)) return;
      settings.offset = Core.clamp(Math.round(v * 2) / 2, Core.OFFSET_MIN, Core.OFFSET_MAX);
      saveSettings();
    },

    // Listens to 3 seconds of normal talking and sets the offset so it reads as
    // a normal conversation (60 dB).
    voiceCalibrate() {
      if (this.calibrating) return;
      const btn = $('voiceCal');
      const label = btn.textContent;
      const finish = () => {
        this.calibrating = false;
        btn.disabled = false;
        btn.textContent = label;
      };
      const run = () => {
        this.calibrating = true;
        btn.disabled = true;
        btn.textContent = '🗣️ Keep talking… 3';
        const levels = [];
        let t0 = null;
        const total = 3000;
        let offState = noop;
        const offFrames = Mic.frames.on((f) => {
          if (!f.warm) return;
          if (t0 === null) t0 = f.t;
          const elapsed = f.t - t0;
          levels.push(f.rawFs);
          btn.textContent = '🗣️ Keep talking… ' + Math.max(1, Math.ceil((total - elapsed) / 1000));
          if (elapsed < total) return;
          offFrames();
          offState();
          finish();
          const level = Core.speechLevel(levels);
          if (level === null) {
            toast("Couldn't hear clear talking. Try again somewhere quiet, talking normally.", 5000);
            return;
          }
          this.setOffset(Core.TALK_DB - level);
          toast('Done! Normal talking now reads about 60 dB (offset ' + fmtOffset(settings.offset) + ').', 5000);
        });
        offState = Mic.changes.on((s) => {
          if (s === 'on') return;
          offFrames();
          offState();
          finish();
        });
      };
      if (Mic.state === 'on') {
        run();
        return;
      }
      btn.disabled = true;
      Mic.start().then(run, (e) => {
        btn.disabled = false;
        showMicError(e);
      });
    },

    // Sets the offset so the current reading (last second, energy-averaged)
    // equals what a real meter shows.
    matchReference() {
      const ref = parseFloat($('refDb').value);
      if (!isFinite(ref) || ref < 20 || ref > 130) {
        toast('Enter the real meter reading (20–130 dB).');
        return;
      }
      if (Mic.state !== 'on' || !Mic.last) {
        toast('Start the mic first, then tap Match.');
        return;
      }
      const recent = Meter.history.filter((p) => p.t >= Mic.last.t - 1000);
      let sum = 0;
      recent.forEach((p) => {
        sum += Core.dbToPower(p.fs);
      });
      const nowFs = recent.length ? Core.powerToDb(sum / recent.length) : Mic.last.fastFs;
      if (nowFs <= Core.SILENCE_DB) {
        toast("The mic isn't picking anything up yet.");
        return;
      }
      this.setOffset(ref - nowFs);
      toast('Calibrated: offset is now ' + fmtOffset(settings.offset));
    },

    render() {
      $('offset').value = settings.offset;
      $('offsetValue').textContent = fmtOffset(settings.offset);
      $('offsetReset').textContent = 'Reset to ' + fmtOffset(Core.DEFAULT_OFFSET).replace(' dB', '');
      document.querySelectorAll('[data-setting]').forEach((el) => {
        const value = settings[el.dataset.setting];
        if (el.type === 'radio') el.checked = el.value === value;
        else if (el.type === 'checkbox') el.checked = !!value;
        else if (document.activeElement !== el && el.value !== value) el.value = value;
      });
      const mine = Core.parseWords(settings.customWords);
      const fill = (sel, text) => document.querySelectorAll(sel).forEach((el) => (el.textContent = text));
      fill('[data-order-help]', ORDER_HELP[settings.targetOrder]);
      fill('[data-word-count]', mine.length + (mine.length === 1 ? ' word' : ' words'));
      fill('[data-both-count]', '100 + ' + mine.length);
      fill('[data-words-help]', wordsHelp(mine.length));
      document.querySelectorAll('[data-words-editor]').forEach((el) => {
        el.hidden = settings.wordSource === 'builtin';
      });
      // keep the game screens in sync (window, target order, phone ceiling)
      if (Game.data) Game.renderBar();
      if (Game.data && Game.phase === 'pass') Game.renderPass();
      if (Game.setup && Game.phase === 'setup') Game.renderSetup();
    },

    onShow() {
      if (Mic.state === 'on' && Mic.last) $('calReading').textContent = fmt1(Math.max(0, spl(Mic.last.fastFs))) + ' dB';
    },
  };

  /* =====================================================================
   * Game
   * =================================================================== */
  const VERDICT = {
    perfect: { text: 'Perfect!', emoji: '🎯' },
    loud: { text: 'Too loud!', emoji: '🙉' },
    quiet: { text: 'Too quiet!', emoji: '🐭' },
  };

  // Team battle: how a saved score is cheered, by how close it got to the limit.
  const RATINGS = {
    amazing: { text: 'Amazing!', emoji: '🤩', outcome: 'perfect' },
    great: { text: 'Great!', emoji: '🔥', outcome: 'perfect' },
    nice: { text: 'Nice!', emoji: '👍', outcome: 'ok' },
    safe: { text: 'Safe!', emoji: '😅', outcome: 'ok' },
  };

  const MODE_HELP = {
    solo: 'Everyone plays for themselves. Hit the target to level up, miss and you drop back to level 1. First to level 10 wins.',
    team: 'Best of three games. Each game, both teams say the same word, player after player, as close to each limit as they dare. Over the limit is a strike and your team starts again; three strikes and you lose that game.',
  };

  // The name editors on the setup screen.
  const ROSTERS = [
    { key: 'solo', label: '', count: 'playerCount', minus: 'pcMinus', plus: 'pcPlus', list: 'nameList', min: Core.GAME.minPlayers, max: Core.GAME.maxPlayers },
    { key: 0, label: 'Team 1, ', count: 't0Count', minus: 't0Minus', plus: 't0Plus', list: 't0Names', min: Core.TEAM.minPlayers, max: Core.TEAM.maxPlayers },
    { key: 1, label: 'Team 2, ', count: 't1Count', minus: 't1Minus', plus: 't1Plus', list: 't1Names', min: Core.TEAM.minPlayers, max: Core.TEAM.maxPlayers },
  ];

  // Highest reading this phone can show: the loudest possible (fully clipped)
  // signal is 0 dBFS, which reads as the calibration offset.
  function meterCeiling() {
    return Math.floor(settings.offset);
  }

  function renderPips(el, filled, total) {
    el.textContent = '';
    const n = total || Core.GAME.winLevel;
    for (let l = 1; l <= n; l++) {
      const pip = document.createElement('i');
      if (l <= filled) pip.className = 'on';
      el.appendChild(pip);
    }
  }

  function renderScoreboard(el, data, highlight) {
    el.textContent = '';
    const best = Math.max.apply(null, data.players.map((p) => p.level));
    data.players.forEach((p, i) => {
      const row = document.createElement('li');
      row.className = 'score-row' + (i === highlight ? ' current' : '');
      const name = document.createElement('span');
      name.className = 'score-name';
      name.textContent = (best > 1 && p.level === best ? '👑 ' : '') + p.name;
      const pips = document.createElement('span');
      pips.className = 'pips';
      renderPips(pips, p.level);
      const lvl = document.createElement('b');
      lvl.className = 'score-level';
      lvl.textContent = p.level;
      row.appendChild(name);
      row.appendChild(pips);
      row.appendChild(lvl);
      el.appendChild(row);
    });
  }

  // Team battle score table: one row per limit, one column per team.
  // `live` marks the cell being played right now.
  function renderBattleTable(el, game, live) {
    const cmp = Core.compareBattle(game);
    el.textContent = '';
    const table = document.createElement('table');
    table.className = 'battle-table';
    const th = (row, text, team) => {
      const cell = document.createElement('th');
      cell.textContent = text;
      if (team !== undefined) cell.dataset.team = String(team);
      row.appendChild(cell);
      return cell;
    };
    const head = table.createTHead().insertRow();
    th(head, 'Limit');
    game.teams.forEach((t, i) => th(head, t.name, i));
    const body = table.createTBody();
    cmp.rows.forEach((r, i) => {
      const row = body.insertRow();
      const limit = row.insertCell();
      limit.className = 'limit';
      limit.textContent = r.limit + ' dB';
      r.scores.forEach((v, ti) => {
        const cell = row.insertCell();
        cell.dataset.team = String(ti);
        const now = live && !game.finished && game.current === ti && game.step === i;
        cell.textContent = v === null ? (now ? '👉' : '—') : v.toFixed(1) + (r.winner === ti ? ' 🏆' : '');
        if (r.winner === ti) cell.classList.add('win');
        if (now) cell.classList.add('now');
      });
    });
    const strikes = table.createTFoot().insertRow();
    th(strikes, 'Strikes');
    game.teams.forEach((t, ti) => {
      const cell = strikes.insertCell();
      cell.dataset.team = String(ti);
      cell.textContent = t.strikes ? '❌'.repeat(t.strikes) : '–';
    });
    const foot = table.tFoot.insertRow();
    if (game.teams.length === 2) {
      th(foot, 'Limits won');
      cmp.wins.forEach((w, ti) => {
        const cell = foot.insertCell();
        cell.dataset.team = String(ti);
        cell.textContent = w;
      });
    } else {
      th(foot, 'Total under');
      foot.insertCell().textContent = cmp.under[0].toFixed(1) + ' dB';
    }
    el.appendChild(table);
    return cmp;
  }

  const Game = {
    data: null, // the saved game (solo: players + levels; team: teams + scores)
    setup: null, // the setup screen's choices, remembered between games
    phase: 'setup',
    turn: null, // the turn in progress: window, floor, word, target
    unsub: null,
    bar: null,

    init() {
      const storedSetup = store.get(KEYS.setup);
      this.setup = Core.sanitizeSetup(storedSetup);
      this.data = Core.sanitizeGame(store.get(KEYS.game)); // finished games too: their results can be shown again
      // first run after an update: fill the setup screen from the saved game
      if (!storedSetup && this.data && this.data.mode === 'solo') {
        this.setup.solo = { count: this.data.players.length, names: this.data.players.map((p) => p.name) };
      }
      $('otherMinus').addEventListener('click', () => this.setOtherCount(this.setup.otherCount - 1));
      $('otherPlus').addEventListener('click', () => this.setOtherCount(this.setup.otherCount + 1));
      $('remeasureBtn').addEventListener('click', () => {
        if (this.phase === 'reveal' && Mic.state === 'on') this.measureFloor();
      });

      ROSTERS.forEach((r) => {
        $(r.minus).addEventListener('click', () => this.setCount(r, this.roster(r).count - 1));
        $(r.plus).addEventListener('click', () => this.setCount(r, this.roster(r).count + 1));
      });
      [0, 1].forEach((i) => {
        $('teamName' + i).addEventListener('input', (e) => {
          this.setup.teams[i].name = e.target.value;
          this.saveSetup();
        });
      });
      document.querySelectorAll('input[name="gameMode"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          if (!radio.checked) return;
          this.setup.mode = radio.value;
          this.saveSetup();
          this.renderSetup();
        });
      });
      document.querySelectorAll('input[name="teamCount"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          if (!radio.checked) return;
          this.setup.teamCount = Number(radio.value);
          this.saveSetup();
          this.renderSetup();
        });
      });
      $('startGame').addEventListener('click', () => this.start());
      $('continueBtn').addEventListener('click', () => {
        Mic.start().catch(showMicError);
        this.showPass();
      });
      $('discardBtn').addEventListener('click', () => this.discard());
      $('readyBtn').addEventListener('click', () => this.ready());
      $('goBtn').addEventListener('click', () => this.go());
      $('nextBtn').addEventListener('click', () => this.showPass());
      $('rematchBtn').addEventListener('click', () => this.rematch());
      $('nextGameBtn').addEventListener('click', () => {
        if (this.isTeam() && Core.nextGame(this.data)) {
          this.save();
          this.showPass();
        }
      });
      $('newPlayersBtn').addEventListener('click', () => this.discard());
      $('quitBtn').addEventListener('click', () => this.quit());
      $('scoresBtn').addEventListener('click', () => this.openScores());
      $('scoresClose').addEventListener('click', () => this.closeScores());
      $('scoresModal').addEventListener('click', (e) => {
        if (e.target === $('scoresModal')) this.closeScores();
      });
      Mic.changes.on((s) => {
        if (s !== 'on' && (this.phase === 'quiet' || this.phase === 'listen')) {
          this.abortTurn('The mic stopped, so that turn was cancelled. Try again!');
        }
      });

      this.renderSetup();
      this.show('setup');
    },

    isTeam() {
      return !!this.data && this.data.mode === 'team';
    },

    player() {
      return this.data.players[this.data.turn];
    },

    screenEl(name) {
      return document.querySelector('#view-game .screen[data-screen="' + name + '"]');
    },

    save() {
      if (this.data) store.set(KEYS.game, this.data);
    },

    saveSetup() {
      store.set(KEYS.setup, this.setup);
    },

    show(screen) {
      this.phase = screen;
      document.querySelectorAll('#view-game .screen').forEach((el) => {
        el.hidden = el.dataset.screen !== screen;
      });
      $('gameBar').hidden = screen === 'setup';
      this.renderBar();
      window.scrollTo(0, 0);
    },

    renderBar() {
      const d = this.data;
      if (!d) return;
      const round = $('gameRound');
      const mode = $('gameMode');
      if (d.mode === 'team') {
        const team = d.teams[d.current];
        round.textContent = team.name;
        round.dataset.team = String(d.current);
        mode.textContent = '❌ ' + team.strikes + '/' + Core.TEAM.strikes;
        mode.title = team.name + ': ' + team.strikes + ' of ' + Core.TEAM.strikes + ' strikes';
        $('scoresBtn').textContent = '📋 Scores';
      } else {
        round.textContent = 'Round ' + d.round;
        round.removeAttribute('data-team');
        const icon = ORDER_ICON[settings.targetOrder];
        mode.textContent = 'Solo' + (icon ? ' · ' + icon : '');
        mode.title = 'Solo game, ' + ORDER_NAME[settings.targetOrder];
        $('scoresBtn').textContent = '🏆 Scores';
      }
    },

    /* ---- setup ---- */
    roster(r) {
      return r.key === 'solo' ? this.setup.solo : this.setup.teams[r.key];
    },

    setCount(r, n) {
      this.roster(r).count = Core.clamp(n, r.min, r.max);
      this.saveSetup();
      this.renderSetup();
    },

    setOtherCount(n) {
      this.setup.otherCount = Core.clamp(n, Core.TEAM.minPlayers, Core.TEAM.maxPlayers);
      this.saveSetup();
      this.renderSetup();
    },

    // Ladder size for a new battle: the bigger team (for "just us", including
    // the team on the other phone).
    battleSteps() {
      const s = this.setup;
      const sizes = s.teams.slice(0, s.teamCount).map((t) => t.count);
      if (s.teamCount === 1) sizes.push(s.otherCount);
      return Math.max.apply(null, sizes);
    },

    renderRoster(r) {
      const roster = this.roster(r);
      $(r.count).textContent = roster.count;
      $(r.minus).disabled = roster.count <= r.min;
      $(r.plus).disabled = roster.count >= r.max;
      const list = $(r.list);
      // Rebuild only when the count changed, so typing isn't interrupted.
      if (list.querySelectorAll('input').length === roster.count) return;
      list.textContent = '';
      for (let i = 0; i < roster.count; i++) {
        const row = document.createElement('div');
        row.className = 'name-row';
        const num = document.createElement('span');
        num.className = 'name-num';
        num.textContent = i + 1;
        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 16;
        input.placeholder = 'Player ' + (i + 1);
        input.value = roster.names[i] || '';
        input.autocomplete = 'off';
        input.setAttribute('autocapitalize', 'words');
        input.setAttribute('enterkeyhint', i === roster.count - 1 ? 'done' : 'next');
        input.setAttribute('aria-label', r.label + 'name of player ' + (i + 1));
        input.addEventListener('input', () => {
          roster.names[i] = input.value;
          this.saveSetup();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          const next = list.querySelectorAll('input')[i + 1];
          if (next) next.focus();
          else input.blur();
        });
        row.appendChild(num);
        row.appendChild(input);
        list.appendChild(row);
      }
    },

    renderSetup() {
      const s = this.setup;
      const team = s.mode === 'team';
      document.querySelectorAll('input[name="gameMode"]').forEach((radio) => {
        radio.checked = radio.value === s.mode;
      });
      document.querySelectorAll('input[name="teamCount"]').forEach((radio) => {
        radio.checked = Number(radio.value) === s.teamCount;
      });
      $('modeHelp').textContent = MODE_HELP[s.mode];
      $('teamCountBlock').hidden = !team;
      $('soloPlayersCard').hidden = team;
      $('teamCard0').hidden = !team;
      $('teamCard1').hidden = !team || s.teamCount === 1;
      [0, 1].forEach((i) => {
        const el = $('teamName' + i);
        if (document.activeElement !== el) el.value = s.teams[i].name;
      });
      ROSTERS.forEach((r) => this.renderRoster(r));

      $('ladderCard').hidden = !team;
      $('otherTeamRow').hidden = !team || s.teamCount !== 1;
      $('otherCount').textContent = s.otherCount;
      $('otherMinus').disabled = s.otherCount <= Core.TEAM.minPlayers;
      $('otherPlus').disabled = s.otherCount >= Core.TEAM.maxPlayers;
      if (team) {
        const sizes = s.teams.slice(0, s.teamCount).map((t) => t.count);
        const ladder = Core.teamLadder(this.battleSteps());
        const ceiling = meterCeiling();
        const box = $('ladderPreview');
        box.textContent = '';
        ladder.forEach((limit, i) => {
          if (i) box.appendChild(document.createTextNode(' → '));
          const step = document.createElement('span');
          step.textContent = limit;
          if (limit >= ceiling) step.className = 'top';
          box.appendChild(step);
        });
        box.appendChild(document.createTextNode(' dB'));
        let help = ladder.length + ' limits';
        if (sizes.every((n) => n === ladder.length)) help += ', one per player';
        else if (s.teamCount === 1) help += sizes[0] < ladder.length ? '; your players take turns to cover them all' : ', one per player';
        else help += "; the smaller team's players take extra turns";
        help += '. Three strikes (going over) and a team loses the game.';
        if (ladder[ladder.length - 1] >= ceiling) {
          help += ' This phone can measure up to about ' + ceiling + ' dB, so on the red limits it is all about screaming as loud as you can.';
        }
        $('ladderHelp').textContent = help;
      }
      document.querySelectorAll('#setupOptions [data-solo-only]').forEach((el) => {
        el.hidden = team;
      });
      $('startGame').textContent = team ? 'Start team battle ⚔️' : 'Start game 🎉';

      const card = $('resumeCard');
      card.hidden = !this.data;
      const over = !!this.data && Core.isGameOver(this.data);
      $('resumeTitle').textContent = over ? 'Last game' : 'Game in progress';
      $('continueBtn').textContent = over ? '🏆 See results' : '▶ Continue';
      if (this.data && over) {
        const d = this.data;
        let info;
        if (d.mode !== 'team') info = d.players[d.winner].name + ' won';
        else if (d.teams.length === 2) {
          const champ = Core.matchWinner(d);
          info = d.teams[champ].name + ' won the match ' + d.wins[champ] + '–' + d.wins[1 - champ];
        } else info = d.teams[0].name + (d.teams[0].out ? ' struck out' : ' finished the ladder');
        $('resumeInfo').textContent = info;
      } else if (this.data && this.data.mode === 'team') {
        const d = this.data;
        $('resumeInfo').textContent =
          d.teams.length === 2
            ? d.teams[0].name + ' ' + d.wins[0] + ' – ' + d.wins[1] + ' ' + d.teams[1].name + ' · game ' + d.gameNo + ' of ' + d.bestOf
            : d.teams[0].name + ' · step ' + (d.step + 1) + ' of ' + d.ladder.length + ' · ' + d.teams[0].strikes + ' strikes';
      } else if (this.data) {
        const leader = this.data.players.reduce((a, b) => (b.level > a.level ? b : a));
        $('resumeInfo').textContent =
          this.data.players.length + ' players · round ' + this.data.round + ' · ' + leader.name + ' leads on level ' + leader.level;
      }
    },

    start() {
      const s = this.setup;
      if (s.mode === 'team') {
        this.data = Core.newBattle(
          s.teams.slice(0, s.teamCount).map((t) => ({ name: t.name, count: t.count, names: t.names })),
          { steps: this.battleSteps() }
        );
      } else {
        this.data = Core.newGame(s.solo.count, s.solo.names);
      }
      this.save();
      // This tap also switches the mic on, so the permission prompt shows now.
      Mic.start().catch(showMicError);
      this.showPass();
    },

    discard() {
      this.unlisten();
      this.data = null;
      this.turn = null;
      store.remove(KEYS.game);
      this.renderSetup();
      this.show('setup');
    },

    quit() {
      if (window.confirm('End this game? Scores will be lost.')) this.discard();
    },

    rematch() {
      if (this.data.mode === 'team') {
        this.data = Core.newBattle(
          this.data.teams.map((t) => ({ name: t.name, count: t.players.length, names: t.players })),
          { steps: this.data.ladder.length }
        );
      } else {
        const names = this.data.players.map((p) => p.name);
        this.data = Core.newGame(names.length, names);
      }
      this.save();
      this.showPass();
    },

    /* ---- a turn ---- */
    showPass() {
      if (!this.data) {
        this.renderSetup();
        this.show('setup');
        return;
      }
      if (this.isTeam() ? this.data.gameOver : Core.isGameOver(this.data)) {
        this.showWin();
        return;
      }
      this.renderPass();
      $('gameError').hidden = true;
      $('readyBtn').disabled = false;
      this.turn = null;
      this.show('pass');
    },

    renderPass() {
      const d = this.data;
      const screen = this.screenEl('pass');
      const team = d.mode === 'team';
      $('passTeam').hidden = !team;
      $('passSoloRule').hidden = team;
      $('passBattleRule').hidden = !team;
      $('passWord').hidden = !team;
      $('passStrikes').hidden = !team;
      $('passMatch').hidden = !team || d.teams.length < 2;
      if (team) {
        const t = d.teams[d.current];
        const limit = d.ladder[d.step];
        screen.dataset.team = String(d.current);
        if (d.teams.length === 2) {
          $('passMatch').textContent =
            'Game ' + d.gameNo + ' of ' + d.bestOf + ' · ' + d.teams[0].name + ' ' + d.wins[0] + ' – ' + d.wins[1] + ' ' + d.teams[1].name;
        }
        $('passTeam').textContent = t.name + ' · step ' + (d.step + 1) + ' of ' + d.ladder.length;
        $('passName').textContent = Core.battlePlayer(d);
        $('passBadgeLabel').textContent = 'Limit ';
        $('passLevel').textContent = limit;
        $('passBadgeSuffix').textContent = ' dB';
        $('passBattleRule').textContent =
          limit >= meterCeiling()
            ? 'Scream as loud as you can: this phone can only measure up to about ' + meterCeiling() + ' dB.'
            : 'Get as close as you can to ' + limit + ' dB without going over.';
        $('passWord').textContent = d.word ? '🔁 The word: ' + d.word : '🆕 New word coming up!';
        $('passStrikes').textContent = '';
        $('passStrikes').appendChild(document.createTextNode('Strikes'));
        const marks = document.createElement('b');
        marks.textContent = '❌'.repeat(t.strikes) + '⬜'.repeat(Core.TEAM.strikes - t.strikes);
        $('passStrikes').appendChild(marks);
        $('passTarget').hidden = true;
        renderPips($('passPips'), d.step, d.ladder.length);
        return;
      }
      screen.removeAttribute('data-team');
      const p = this.player();
      const planned = Core.plannedTarget(p.level, settings.targetOrder);
      $('passName').textContent = p.name;
      $('passBadgeLabel').textContent = 'Level ';
      $('passLevel').textContent = p.level;
      $('passBadgeSuffix').textContent = '/10';
      $('passWindow').textContent = Core.windowForLevel(p.level, settings.difficulty);
      $('passTarget').hidden = planned === null;
      $('passTargetIcon').textContent = ORDER_ICON[settings.targetOrder];
      $('passTargetValue').textContent = planned;
      renderPips($('passPips'), p.level);
    },

    ready() {
      if (this.phase !== 'pass') return;
      const begin = () => {
        if (this.phase === 'pass' && activeTab === 'game' && Mic.state === 'on') this.measureFloor();
      };
      if (Mic.state === 'on') {
        begin();
        return;
      }
      // We're inside a tap, so this is allowed to start the mic (iOS needs that).
      const btn = $('readyBtn');
      btn.disabled = true;
      Mic.start()
        .then(begin, (e) => {
          showMicError(e);
          if (e.code !== 'aborted') {
            $('gameError').textContent = e.message;
            $('gameError').hidden = false;
          }
        })
        .then(() => {
          btn.disabled = false;
        });
    },

    // One second of silence = the noise floor for this turn.
    measureFloor() {
      const team = this.isTeam();
      this.turn = {
        win: team ? Core.TEAM.sweetSpot : Core.windowForLevel(this.player().level, settings.difficulty),
        floorFs: null,
        word: null,
        target: null,
      };
      this.show('quiet');
      const bar = $('quietBar');
      bar.classList.remove('run');
      void bar.offsetWidth;
      bar.classList.add('run');
      const samples = [];
      let t0 = null;
      this.listen((f) => {
        if (t0 === null) t0 = f.t;
        const elapsed = f.t - t0;
        if (elapsed < Core.GAME.settleMs) return;
        samples.push(f.rawFs);
        if (elapsed >= Core.GAME.settleMs + Core.GAME.floorMs) {
          this.unlisten();
          this.reveal(Core.median(samples));
        }
      });
    },

    reveal(floorFs) {
      const t = this.turn;
      const d = this.data;
      const team = d.mode === 'team';
      const screen = this.screenEl('reveal');
      t.floorFs = floorFs;
      const floorSpl = spl(floorFs);
      if (team) {
        const tm = d.teams[d.current];
        if (!d.word) d.word = Core.drawWord(d, Core.wordList(settings)); // one word per game, for both teams
        t.word = d.word;
        t.target = d.ladder[d.step];
        t.win = Core.TEAM.sweetSpot;
        screen.dataset.team = String(d.current);
        $('revealKicker').textContent = tm.name + ' · ' + Core.battlePlayer(d) + ' · step ' + (d.step + 1) + '/' + d.ladder.length;
        $('revealAt').textContent = 'limit';
        const ceiling = meterCeiling();
        $('revealMax').hidden = t.target < ceiling;
        $('revealMax').textContent = '📱 This phone measures up to about ' + ceiling + ' dB, so for this limit: scream as loud as you can!';
        const margins = Core.battleMargins(floorSpl, t.target);
        $('revealNoisy').hidden = !margins.tooNoisy;
        $('revealNoisyText').textContent =
          "🔊 Too noisy for this limit: the room was " + Math.round(floorSpl) + ' dB, so anything we could hear would be over ' + t.target + ' dB. Hush everyone and measure again.';
        $('revealRaised').hidden = true;
      } else {
        const p = this.player();
        const pick = Core.targetFor(p.level, { order: settings.targetOrder, difficulty: settings.difficulty, floor: floorSpl });
        t.win = pick.win;
        t.target = pick.target;
        t.word = Core.drawWord(d, Core.wordList(settings));
        screen.removeAttribute('data-team');
        $('revealKicker').textContent = p.name + ' · level ' + p.level;
        $('revealAt').textContent = 'at';
        $('revealRange').textContent = t.target - t.win + '–' + t.target + ' dB';
        $('revealRaised').hidden = !pick.raised;
        $('revealMax').hidden = true;
        $('revealNoisy').hidden = true;
      }
      this.save(); // remembers which words were used
      $('revealChipSolo').hidden = team;
      // above what the phone can measure, the only advice is "scream"
      $('revealChipBattle').hidden = !team || !$('revealMax').hidden;
      $('revealWord').textContent = t.word;
      $('revealTarget').textContent = t.target;
      $('revealRoom').textContent = Math.max(0, Math.round(floorSpl));
      this.show('reveal');
    },

    go() {
      if (this.phase !== 'reveal') return;
      if (Mic.state !== 'on') {
        this.abortTurn('The mic is off. Tap "I\'m ready" to turn it back on.');
        return;
      }
      const t = this.turn;
      const floorSpl = spl(t.floorFs);
      const detector = new Core.WordDetector(floorSpl, this.isTeam() ? Core.battleMargins(floorSpl, t.target) : undefined);
      this.setupBar(t.target, t.win, floorSpl);
      $('listenWord').textContent = t.word;
      $('listenTargetLine').textContent = this.isTeam() ? 'Limit ' + t.target + ' dB' : 'Target ' + (t.target - t.win) + '–' + t.target + ' dB';
      $('listenStatus').textContent = 'Say it now!';
      $('listenValue').textContent = '--';
      this.show('listen');
      this.listen((f) => {
        const fast = spl(f.fastFs);
        const result = detector.push(f.t, spl(f.rawFs), fast);
        this.updateBar(fast, detector.started ? detector.peak : null);
        $('listenStatus').textContent = detector.started ? 'Hearing you…' : 'Say it now!';
        if (result) {
          this.unlisten();
          this.finish(result);
        }
      });
    },

    finish(res) {
      if (this.isTeam()) {
        this.finishBattle(res);
        return;
      }
      const t = this.turn;
      const p = this.player();
      const outcome = res.heard ? Core.judge(res.peak, t.target, t.win) : 'quiet';
      const change = Core.applyOutcome(this.data, outcome);
      this.save(); // finished games stay saved, so their results survive a reload
      if (outcome !== 'perfect') buzz([90, 60, 220]);
      if (change.won) {
        this.showWin({ word: t.word, peak: res.peak });
        return;
      }
      this.renderResult(outcome, res, t, p, change);
      if (outcome === 'perfect') Confetti.burst(90);
    },

    finishBattle(res) {
      const change = Core.applyBattle(this.data, res);
      this.save(); // finished matches stay saved, so their results survive a reload
      if (change.kind === 'bust' || change.kind === 'out') buzz([90, 60, 220]);
      this.renderBattleResult(change);
      if (change.kind === 'saved' && change.limit - change.score <= 1) Confetti.burst(90);
    },

    // The marker strip on the result screen: where the peak landed.
    renderStrip(target, win, peak) {
      const lo = target - 15;
      const hi = target + 9;
      const pct = (v) => Core.clamp(((v - lo) / (hi - lo)) * 100, 0, 100);
      $('stripWindow').style.left = pct(target - win) + '%';
      $('stripWindow').style.width = pct(target) - pct(target - win) + '%';
      $('stripTarget').style.left = pct(target) + '%';
      const marker = $('stripMarker');
      marker.hidden = peak === null;
      if (peak !== null) {
        marker.style.left = pct(peak) + '%';
        $('stripMarkerLabel').textContent = peak.toFixed(1);
      }
    },

    renderResult(outcome, res, t, p, change) {
      const screen = this.screenEl('result');
      screen.dataset.outcome = outcome;
      screen.removeAttribute('data-team');
      $('resultTeam').hidden = true;
      $('resultEmoji').textContent = VERDICT[outcome].emoji;
      $('resultVerdict').textContent = VERDICT[outcome].text;
      const peak = res.heard ? Core.round1(res.peak) : null;
      $('resultPeak').textContent = peak === null ? '--' : peak.toFixed(1) + ' dB';
      $('resultTargetLabel').textContent = 'Target';
      $('resultTarget').textContent = t.target - t.win + '–' + t.target + ' dB';

      let delta;
      if (!res.heard) delta = "We didn't hear anything. Speak up!";
      else if (outcome === 'loud') delta = (peak - t.target).toFixed(1) + ' dB over the line';
      else if (outcome === 'quiet') delta = (t.target - t.win - peak).toFixed(1) + ' dB short of the window';
      else if (peak === t.target) delta = 'Right on the line. Bullseye!';
      else delta = (t.target - peak).toFixed(1) + ' dB under the line';
      $('resultDelta').textContent = delta;

      let level;
      if (change.reset === 'player') level = change.before > 1 ? p.name + ' drops from level ' + change.before + ' back to 1' : p.name + ' stays on level 1';
      else level = p.name + ': level ' + change.before + ' → ' + change.after + ' ⬆️';
      $('resultLevel').textContent = level;

      this.renderStrip(t.target, t.win, peak);
      $('nextBtn').textContent = 'Next: ' + this.player().name + ' →';
      $('resultScores').hidden = false;
      $('resultBattle').hidden = true;
      renderScoreboard($('resultScores'), this.data, change.index);
      this.show('result');
    },

    renderBattleResult(change) {
      const d = this.data;
      const team = d.teams[change.team];
      const screen = this.screenEl('result');
      screen.dataset.team = String(change.team);
      $('resultTeam').hidden = false;
      $('resultTeam').textContent = team.name + ' · step ' + (change.step + 1) + ' of ' + d.ladder.length;
      let v = null;
      if (change.kind === 'retry') v = { outcome: 'quiet', emoji: '👂', text: "Didn't hear you!" };
      else if (change.kind === 'bust') v = { outcome: 'loud', emoji: '🙉', text: 'Too loud!' };
      else if (change.kind === 'out') v = { outcome: 'loud', emoji: '❌', text: 'Strike 3!' };
      // above what the phone can measure, closeness is judged against its maximum
      const reach = Math.min(change.limit, meterCeiling());
      if (!v) v = RATINGS[Core.rateCloseness(Math.max(0, Core.round1(reach - change.score)))];
      screen.dataset.outcome = v.outcome;
      $('resultEmoji').textContent = v.emoji;
      $('resultVerdict').textContent = v.text;
      const scored = change.kind !== 'retry';
      $('resultPeak').textContent = scored ? change.score.toFixed(1) + ' dB' : '--';
      $('resultTargetLabel').textContent = 'Limit';
      $('resultTarget').textContent = change.limit + ' dB';

      let delta;
      let line;
      if (change.kind === 'retry') {
        delta = 'Nothing was louder than the room.';
        line = 'Same word, same limit: ' + change.player + ' tries again.';
      } else if (change.kind === 'bust' || change.kind === 'out') {
        delta = Core.round1(change.score - change.limit).toFixed(1) + ' dB over the ' + change.limit + ' dB limit';
        if (change.kind === 'bust') {
          line = 'Strike ' + change.strikes + ' of ' + Core.TEAM.strikes + '! ' + team.name + ' goes back to step 1, same word.';
        } else if (change.result && change.result.winner !== null) {
          line = team.name + ' struck out: ' + d.teams[change.result.winner].name + ' win game ' + change.gameNo + '!';
        } else {
          line = team.name + ' struck out!';
        }
      } else {
        const under = Core.round1(change.limit - change.score);
        if (reach < change.limit) delta = Math.max(0, Core.round1(reach - change.score)).toFixed(1) + " dB under this phone's maximum (about " + reach + ' dB)';
        else delta = under === 0 ? 'Exactly on the limit!' : under.toFixed(1) + ' dB under the limit';
        line = 'Saved: ' + change.score.toFixed(1) + ' for ' + team.name + ' at the ' + change.limit + ' dB limit';
        if (change.teamDone) line += '. Ladder complete! 🎉';
      }
      $('resultDelta').textContent = delta;
      $('resultLevel').textContent = line;
      this.renderStrip(change.limit, Core.TEAM.sweetSpot, scored ? change.score : null);

      let next;
      if (change.gameOver) next = d.teams.length === 2 ? 'See game ' + change.gameNo + ' result 🏆' : 'See the results 🏆';
      else if (change.nextTeam !== undefined) next = d.teams[change.nextTeam].name + "'s turn →";
      else if (change.kind === 'retry') next = 'Try again →';
      else if (change.kind === 'bust') next = 'Start again: ' + Core.battlePlayer(d) + ' →';
      else next = 'Next: ' + Core.battlePlayer(d) + ' →';
      $('nextBtn').textContent = next;
      $('resultScores').hidden = true;
      $('resultBattle').hidden = false;
      renderBattleTable($('resultBattle'), d, true);
      this.show('result');
    },

    showWin(last) {
      if (this.isTeam()) {
        this.showBattleEnd();
        return;
      }
      const d = this.data;
      const w = d.players[d.winner];
      this.screenEl('win').removeAttribute('data-team');
      $('winTrophy').textContent = '🏆';
      $('winName').textContent = w.name;
      $('winSuffix').textContent = ' wins!';
      $('winMsg').textContent = w.name + ' reached level 10 first.';
      $('winLast').textContent = last ? 'Winning word: "' + last.word + '" at ' + Core.round1(last.peak).toFixed(1) + ' dB' : '';
      $('winScores').hidden = false;
      $('winBattle').hidden = true;
      $('winHistory').hidden = true;
      $('nextGameBtn').hidden = true;
      $('winButtons').hidden = false;
      $('rematchBtn').textContent = '🔁 Rematch';
      $('newPlayersBtn').textContent = 'New players';
      renderScoreboard($('winScores'), d, d.winner);
      this.show('win');
      Confetti.burst(240);
    },

    // A game of the battle is over: the game result, or the match result.
    showBattleEnd() {
      const d = this.data;
      const screen = this.screenEl('win');
      const last = d.history[d.history.length - 1];
      const two = d.teams.length === 2;
      $('winScores').hidden = true;
      $('winBattle').hidden = false;
      renderBattleTable($('winBattle'), d, false);
      const reasonText = (h) => {
        if (h.reason === 'strikes') return d.teams[h.out].name + ' struck out (3 strikes).';
        if (h.reason === 'limits') return 'Closest at ' + h.wins[h.winner] + ' of ' + d.ladder.length + ' limits (' + d.teams[1 - h.winner].name + ': ' + h.wins[1 - h.winner] + ').';
        if (h.reason === 'closer') return 'Level on limits, but closer overall: ' + h.under[h.winner].toFixed(1) + ' vs ' + h.under[1 - h.winner].toFixed(1) + ' dB under.';
        if (h.reason === 'tie') return 'Exactly as close at every limit: a draw, so it is replayed.';
        return '';
      };
      let trophy;
      let name;
      let suffix;
      let msg;
      let match = '';
      if (!two) {
        const team = d.teams[0];
        name = team.name;
        if (last.reason === 'out') {
          trophy = '❌';
          suffix = ' struck out';
          msg = 'Three times over the limit with "' + last.word + '". Shake it off and play again!';
        } else {
          const cmp = Core.compareBattle(d);
          trophy = '🏁';
          suffix = ' finished!';
          msg =
            'All ' + d.ladder.length + ' limits done with ' + team.strikes + ' strike' + (team.strikes === 1 ? '' : 's') + ', ' +
            cmp.under[0].toFixed(1) + ' dB under in total. Compare with the other team: at each limit, the closer team wins it.';
        }
        screen.dataset.team = '0';
      } else {
        match = 'Match: ' + d.teams[0].name + ' ' + d.wins[0] + ' – ' + d.wins[1] + ' ' + d.teams[1].name + ' · best of ' + d.bestOf;
        if (d.finished) {
          const champ = Core.matchWinner(d);
          trophy = '🏆';
          name = d.teams[champ].name;
          suffix = ' win the match!';
          msg = 'Game ' + last.gameNo + ': ' + reasonText(last) + ' Final score ' + d.wins[champ] + '–' + d.wins[1 - champ] + ' in games.';
          screen.dataset.team = String(champ);
        } else if (last.winner === null) {
          trophy = '🤝';
          name = 'Game ' + last.gameNo;
          suffix = ' is a draw!';
          msg = reasonText(last);
          screen.removeAttribute('data-team');
        } else {
          trophy = '🏅';
          name = d.teams[last.winner].name;
          suffix = ' win game ' + last.gameNo + '!';
          msg = reasonText(last) + ' Next game: ' + d.teams[(last.gameNo) % 2].name + ' start.';
          screen.dataset.team = String(last.winner);
        }
      }
      $('winTrophy').textContent = trophy;
      $('winName').textContent = name;
      $('winSuffix').textContent = suffix;
      $('winMsg').textContent = msg;
      $('winLast').textContent = match;

      // games played so far
      const list = $('winHistory');
      list.textContent = '';
      list.hidden = !two;
      if (two) {
        d.history.forEach((h) => {
          const li = document.createElement('li');
          if (h.winner !== null) li.dataset.team = String(h.winner);
          const no = document.createElement('span');
          no.className = 'game-no';
          no.textContent = 'Game ' + h.gameNo;
          const who = document.createElement('b');
          who.textContent = h.winner === null ? '🤝 Draw' : '🏅 ' + d.teams[h.winner].name;
          const why = document.createElement('small');
          let reason = 'replayed';
          if (h.reason === 'strikes') reason = d.teams[h.out].name + ' struck out';
          else if (h.reason === 'limits') reason = h.wins[h.winner] + '–' + h.wins[1 - h.winner] + ' on limits';
          else if (h.reason === 'closer') reason = 'closer overall';
          why.textContent = reason + (h.word ? ' · ' + h.word : '');
          li.appendChild(no);
          li.appendChild(who);
          li.appendChild(why);
          list.appendChild(li);
        });
      }
      const more = two && !d.finished;
      $('nextGameBtn').hidden = !more;
      $('nextGameBtn').textContent = 'Start game ' + (d.gameNo + 1) + ' →';
      $('winButtons').hidden = more;
      $('rematchBtn').textContent = two ? '🔁 New match' : '🔁 Play again';
      $('newPlayersBtn').textContent = 'New teams';
      this.show('win');
      if (trophy !== '❌') Confetti.burst(d.finished ? 240 : 120);
    },

    abortTurn(message) {
      this.unlisten();
      if (!this.data) return;
      this.showPass();
      if (message) {
        $('gameError').textContent = message;
        $('gameError').hidden = false;
      }
    },

    onLeave() {
      if (this.phase === 'quiet' || this.phase === 'listen') this.abortTurn();
    },

    listen(fn) {
      this.unlisten();
      this.unsub = Mic.frames.on(fn);
    },

    unlisten() {
      if (this.unsub) this.unsub();
      this.unsub = null;
    },

    /* ---- the live bar ---- */
    setupBar(target, win, floorSpl) {
      const lo = target - 30;
      const hi = target + 12;
      const pct = (v) => Core.clamp(((v - lo) / (hi - lo)) * 100, 0, 100);
      this.bar = { target: target, win: win, pct: pct, state: null };
      $('barOver').style.bottom = pct(target) + '%';
      $('barWindow').style.bottom = pct(target - win) + '%';
      $('barWindow').style.height = pct(target) - pct(target - win) + '%';
      $('barTarget').style.bottom = pct(target) + '%';
      $('barTargetLabel').textContent = target;
      const floor = $('barFloor');
      floor.hidden = !(floorSpl > lo + 1 && floorSpl < target - win - 1);
      floor.style.bottom = pct(floorSpl) + '%';
      $('barPeak').hidden = true;
      $('barFill').style.transform = 'scaleY(0)';
      $('barFill').dataset.state = 'below';
      const scale = $('barScale');
      scale.textContent = '';
      for (let v = Math.ceil(lo / 5) * 5; v <= hi; v += 5) {
        const tick = document.createElement('span');
        tick.style.bottom = pct(v) + '%';
        tick.textContent = v;
        scale.appendChild(tick);
      }
    },

    updateBar(level, peak) {
      const b = this.bar;
      $('barFill').style.transform = 'scaleY(' + (b.pct(level) / 100).toFixed(4) + ')';
      const state = level > b.target ? 'over' : level >= b.target - b.win ? 'in' : 'below';
      if (state !== b.state) {
        b.state = state;
        $('barFill').dataset.state = state;
      }
      $('listenValue').textContent = fmt1(Math.max(0, level));
      if (peak !== null) {
        const el = $('barPeak');
        el.hidden = false;
        el.style.bottom = b.pct(peak) + '%';
      }
    },

    /* ---- scoreboard dialog ---- */
    openScores() {
      if (!this.data) return;
      const team = this.isTeam();
      $('scoresList').hidden = team;
      $('scoresBattle').hidden = !team;
      if (team) renderBattleTable($('scoresBattle'), this.data, true);
      else renderScoreboard($('scoresList'), this.data, this.data.winner !== null ? this.data.winner : this.data.turn);
      $('scoresModal').hidden = false;
      document.querySelector('#scoresModal .modal-card').scrollTop = 0;
      $('scoresClose').focus({ preventScroll: true });
    },

    closeScores() {
      $('scoresModal').hidden = true;
    },
  };

  /* =====================================================================
   * Confetti (for hits and wins)
   * =================================================================== */
  const Confetti = {
    parts: [],
    raf: 0,
    burst(count) {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const c = $('confetti');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.classList.add('on');
      const colors = ['#ff3e9a', '#ffd23f', '#2fe3ff', '#34e07a', '#8b5cff', '#ff8a3d'];
      for (let i = 0; i < count; i++) {
        this.parts.push({
          x: w / 2 + (Math.random() - 0.5) * w * 0.4,
          y: h * 0.32 + (Math.random() - 0.5) * 40,
          vx: (Math.random() - 0.5) * 14,
          vy: -Math.random() * 14 - 4,
          size: 6 + Math.random() * 7,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 0.4,
          color: colors[i % colors.length],
          round: Math.random() < 0.3,
        });
      }
      if (this.raf) return;
      let last = performance.now();
      const step = (now) => {
        const k = Math.min(2.5, (now - last) / 16.7);
        last = now;
        const ctx = c.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        this.parts = this.parts.filter((p) => p.y < h + 30);
        this.parts.forEach((p) => {
          p.vy += 0.35 * k;
          p.vx *= Math.pow(0.99, k);
          p.x += p.vx * k;
          p.y += p.vy * k;
          p.rot += p.vr * k;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          if (p.round) {
            ctx.beginPath();
            ctx.arc(0, 0, p.size / 2.4, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          }
          ctx.restore();
        });
        if (this.parts.length) {
          this.raf = requestAnimationFrame(step);
        } else {
          this.raf = 0;
          c.classList.remove('on');
        }
      };
      this.raf = requestAnimationFrame(step);
    },
  };

  /* =====================================================================
   * Tabs, install help, lifecycle
   * =================================================================== */
  let activeTab = 'meter';

  function showTab(name) {
    if (name === activeTab) return;
    const prev = activeTab;
    activeTab = name;
    document.querySelectorAll('.view').forEach((v) => {
      v.hidden = v.dataset.view !== name;
    });
    document.querySelectorAll('.tab').forEach((t) => {
      t.setAttribute('aria-selected', String(t.dataset.tab === name));
    });
    if (prev === 'game') Game.onLeave();
    if (name === 'meter') Meter.onShow();
    if (name === 'settings') SettingsView.onShow();
    window.scrollTo(0, 0);
  }

  let installEvent = null;

  function renderInstall() {
    const standalone = isStandalone();
    $('installBtn').hidden = !installEvent || standalone;
    $('installStatus').textContent = standalone
      ? "✅ You're using the home-screen app."
      : installEvent
        ? 'Install Loud Enough for one-tap access, even offline:'
        : 'Open it like an app, straight from your home screen, even offline:';
    // show this device's instructions first
    const steps = $('installSteps');
    const ios = steps.querySelector('[data-platform="ios"]');
    if (!isIOS) steps.appendChild(ios);
    steps.hidden = standalone;
    $('installTip').hidden = standalone || !!store.get(KEYS.tip);
  }

  function initInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installEvent = e;
      renderInstall();
    });
    window.addEventListener('appinstalled', () => {
      installEvent = null;
      renderInstall();
      toast('Installed! Open Loud Enough from your home screen.');
    });
    $('installBtn').addEventListener('click', () => {
      if (!installEvent) return;
      const e = installEvent;
      installEvent = null;
      e.prompt();
      Promise.resolve(e.userChoice).catch(noop).then(renderInstall);
    });
    $('installTipHow').addEventListener('click', () => {
      showTab('settings');
      $('installCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('installTipClose').addEventListener('click', () => {
      store.set(KEYS.tip, true);
      $('installTip').hidden = true;
    });
    renderInstall();
  }

  function initServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Loud Enough was updated. Reopen the app to get the new version.', 6000);
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch((e) => console.warn('Service worker:', e));
    });
  }

  function init() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => showTab(tab.dataset.tab));
    });
    Mic.changes.on((s) => {
      const labels = { off: 'Mic off', starting: 'Starting…', on: 'Live', paused: 'Paused' };
      $('micPill').dataset.state = s;
      $('micPillText').textContent = labels[s];
      $('resumeBanner').hidden = s !== 'paused';
    });
    $('resumeBtn').addEventListener('click', () => Mic.start().catch(showMicError));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (WakeLock.wanted) WakeLock.acquire();
      Mic.wake();
    });
    window.addEventListener('pageshow', () => Mic.wake());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') Game.closeScores();
    });

    Meter.init();
    SettingsView.init();
    Game.init();
    initInstall();
    initServiceWorker();
    Meter.onShow();
  }

  // Exposed for debugging in the browser console.
  root.LoudEnough = { Core: Core, Mic: Mic, Meter: Meter, Game: Game, settings: settings, version: VERSION };

  init();
})(typeof window !== 'undefined' ? window : globalThis);
