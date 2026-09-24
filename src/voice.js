// Claw'd's voice: he says the ask out loud when Claude needs you.
//
// Speaks on `needs_input` and `error` ONLY — the two states that have to carry
// across a room. Everything else stays quiet; a pet that narrates every tool
// call gets muted by week two.
//
// What he says is an opener chosen from the reducer's own `kind` (the same
// classification the speech bubble already uses — there is no second
// taxonomy here), optionally followed by the bubble's detail text.
//
// BACKENDS. `speak()` routes to one of these, so the engine can change
// without anything else moving:
//   system — SpeechSynthesis (the Windows voices, via WebView2). No assets,
//            no install, works offline. The default.
//   espeak — eSpeak NG compiled to WebAssembly: the retro formant synth.
//            Slots in here; costs ~25MB embedded in the exe.
// A backend that fails to load falls back to `system` rather than going
// silent, so a broken engine is never a broken pet.
'use strict';

// --- what he says -----------------------------------------------------
//
// Keyed by the reducer's `kind` (see KIND_TEXT in index.html and
// state.rs): permission | idle_prompt | agent_needs_input |
// elicitation_dialog | elicitation | unknown, plus '' for anything that
// is not needs_input. Several lines per key so a long afternoon of
// prompts isn't one sentence on a loop.
const LINES = {
  elicitation:        ['Hello friend. I have a question.', '{name} is asking you something.', 'Hey! {name} has a question for you.'],
  elicitation_dialog: ['Hello friend. I have a question.', '{name} wants to ask you something.'],
  permission:         ['{name} is asking permission.', 'Hello friend. {name} needs your OK.'],
  idle_prompt:        ['{name} is waiting on you.', 'Hey. {name} is waiting.'],
  agent_needs_input:  ['{name} needs your input.', 'Hello friend. {name} needs you.'],
  unknown:            ['{name} wants something.', 'Hey. {name} needs a look.'],
  error:              ['{name} hit an error.', 'Uh oh. {name} broke something.'],
};

// Cooldown, bucketed by STATE rather than by kind. The reducer can flap while
// a session list settles — and it flaps the *kind* too (idle_prompt ->
// permission -> elicitation on one session), so a per-kind cooldown lets the
// same settling burst speak three times. One bucket for every flavour of ask
// is what actually keeps him quiet. Rust already suppresses byte-identical
// payloads; this is the belt to that pair of braces.
const COOLDOWN_MS = { needs_input: 20000, error: 30000 };

const MAX_CHARS = 300;

// --- settings ---------------------------------------------------------

// Preference order when nothing has been picked yet. Substring match on the
// voice name, so it survives the "Microsoft X - English (United States)"
// wrapping and works on a machine with a different set installed.
const PREFERRED = ['Mark', 'Guy', 'David', 'Zira'];

const DEFAULTS = {
  enabled: true,
  backend: 'system',
  voiceName: '',   // '' = fall back to PREFERRED, then the browser default
  volume: 0.9,
  rate: 1,
  // Well above natural, chosen by ear: the Windows voices are newsreader-flat
  // and Mark at this pitch is the one that reads as a small colleague rather
  // than a narrator. Squarely in cartoon territory, which is the point.
  pitch: 1.8,
  speakDetail: true,
};

// pitch tops out at 2 because that is the Web Speech API's own maximum, not
// because anything here breaks first
const LIMITS = { pitch: [0.5, 2], rate: [0.6, 1.6], volume: [0, 1] };
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));

let settings = { ...DEFAULTS };
try {
  const raw = localStorage.getItem('voice');
  if (raw) settings = { ...DEFAULTS, ...(JSON.parse(raw) || {}) };
} catch {}

function save() {
  try { localStorage.setItem('voice', JSON.stringify(settings)); } catch {}
}

function get() { return { ...settings }; }
function set(patch) {
  settings = { ...settings, ...patch };
  for (const k of Object.keys(LIMITS)) {
    if (typeof settings[k] === 'number') settings[k] = clamp(settings[k], LIMITS[k]);
  }
  save();
}
// nudge a numeric setting by a step and return the new value (for +/- buttons)
function nudge(key, step) {
  if (!LIMITS[key]) return settings[key];
  set({ [key]: (Number(settings[key]) || 0) + step });
  return settings[key];
}

// --- text shaping -----------------------------------------------------

// The detail is whatever Claude is asking, so it can carry file paths, tool
// names and stack traces. Read literally those turn into a minute of
// punctuation; this keeps the sentence and throws away the machinery.
function sanitise(text) {
  if (!text) return '';
  const basename = (m) => m.split(/[\\/]/).filter(Boolean).pop() || '';
  return String(text)
    // URLs go FIRST — otherwise the path rules below eat "example.com/a/b"
    // out of the middle of one and leave the "http" behind
    .replace(/https?:\/\/\S+/g, 'a link')
    // C:\Users\Queen Mapache\...\index.html -> index.html. An interior
    // segment may hold ONE space, because real home folders do ("Queen
    // Mapache"), but no more — otherwise a path followed by prose that
    // happens to contain a slash ("...\main.rs then run tests/unit/x.sh")
    // matches the prose as one giant segment and eats the sentence.
    .replace(/[A-Za-z]:[\\/](?:[^\\/\r\n\s]+(?: [^\\/\r\n\s]+)?[\\/])*[^\\/\r\n\s"',;]*/g, basename)
    // relative paths: src/tauri/main.rs -> main.rs
    .replace(/(?:[\w.-]+[\\/]){2,}[\w.-]+/g, basename)
    .replace(/[`*_~#|]+/g, ' ')        // markdown furniture
    .replace(/[-=]{3,}/g, ' ')          // rules
    .replace(/\s+/g, ' ')
    .trim();
}

function cap(text, n = MAX_CHARS) {
  if (text.length <= n) return text;
  const cut = text.slice(0, n);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '), cut.lastIndexOf(' '));
  return (stop > n * 0.6 ? cut.slice(0, stop) : cut).trim();
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Compose what he should say for a reduced payload. Exported so the host can
// show it (and so it can be unit-checked without making a sound).
function lineFor(state, kind, name, detail) {
  const key = state === 'error' ? 'error' : (LINES[kind] ? kind : 'unknown');
  const opener = pick(LINES[key]).replace(/\{name\}/g, name || 'Claude');
  if (!settings.speakDetail) return opener;
  const body = cap(sanitise(detail));
  if (!body) return opener;
  // don't say the same thing twice when the detail just restates the opener
  if (opener.toLowerCase().includes(body.toLowerCase().slice(0, 24))) return opener;
  return opener + ' ' + body;
}

// --- backends ---------------------------------------------------------

const systemBackend = {
  name: 'system',
  async ready() { return typeof window.speechSynthesis !== 'undefined'; },
  voices() {
    if (typeof window.speechSynthesis === 'undefined') return [];
    return speechSynthesis.getVoices().filter((v) => v.lang && v.lang.startsWith('en'));
  },
  // the chosen voice, else the first PREFERRED one installed, else whatever
  // the engine defaults to
  chosen() {
    const list = this.voices();
    if (!list.length) return null;
    const exact = list.find((x) => x.name === settings.voiceName);
    if (exact) return exact;
    for (const want of PREFERRED) {
      const hit = list.find((x) => x.name.includes(want));
      if (hit) return hit;
    }
    return null;
  },
  speak(text) {
    const u = new SpeechSynthesisUtterance(text);
    const v = this.chosen();
    if (v) u.voice = v;
    u.volume = settings.volume;
    u.rate = settings.rate;
    u.pitch = settings.pitch;
    speechSynthesis.cancel(); // an alert supersedes whatever was mid-sentence
    speechSynthesis.speak(u);
  },
  stop() { try { speechSynthesis.cancel(); } catch {} },
};

// eSpeak NG (WebAssembly). Lazily loaded on first use, never at boot — alerts
// are rare and this must stay out of the startup path. Left unimplemented
// until the engine is vendored; `ready()` returning false makes speak() fall
// back to the system voice, so wiring it up early costs nothing.
const espeakBackend = {
  name: 'espeak',
  _mod: null,
  async ready() {
    if (this._mod) return true;
    try {
      const m = await import('./vendor/espeak/espeak.js');
      this._mod = await m.init();
      return true;
    } catch (err) {
      console.warn('espeak unavailable, using the system voice:', err && err.message);
      return false;
    }
  },
  speak(text) { this._mod.speak(text, settings); },
  stop() { if (this._mod && this._mod.stop) this._mod.stop(); },
};

const BACKENDS = { system: systemBackend, espeak: espeakBackend };

let active = null;

async function backend() {
  const want = BACKENDS[settings.backend] || systemBackend;
  if (active === want) return active;
  active = (await want.ready()) ? want : systemBackend;
  return active;
}

// Warm the engine without making a sound — call when the user switches the
// toggle on, so the first real alert isn't the one that pays the load cost.
async function warm() { if (settings.enabled) await backend(); }

// --- speaking ---------------------------------------------------------

const lastSpokeAt = {};

function stop() { Object.values(BACKENDS).forEach((b) => { try { b.stop(); } catch {} }); }

// Say something now, ignoring cooldowns. Used by the settings Test button.
async function say(text) {
  if (!text) return false;
  const b = await backend();
  try { b.speak(text); return true; } catch (err) { console.warn('speak failed', err); return false; }
}

// The alert path: compose, cooldown-check, speak. Returns the spoken string,
// or null if it was suppressed (disabled, or too soon after the last one).
async function alert({ state, kind, name, detail }) {
  if (!settings.enabled) return null;
  if (state !== 'needs_input' && state !== 'error') return null;
  const key = state; // 'needs_input' | 'error' — see COOLDOWN_MS
  const now = Date.now();
  if (now - (lastSpokeAt[key] || 0) < COOLDOWN_MS[key]) return null;
  const text = lineFor(state, kind, name, detail);
  lastSpokeAt[key] = now;
  await say(text);
  return text;
}

export { alert, say, warm, stop, get, set, nudge, lineFor, sanitise, systemBackend, DEFAULTS, LIMITS };
