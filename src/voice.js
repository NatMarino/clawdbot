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
// Greeting and ask are SEPARATE, because a pet that opens every single
// sentence with "Hello friend" stops being charming by the third time. The
// greeting shows up sometimes (GREET_CHANCE) and never twice running.
const GREETINGS = [
  'Hello friend.', 'Hey.', 'Hi there.', 'Psst.', 'Oh!', 'Hello.',
  'Excuse me.', 'Hey friend.', 'Ahem.',
];
const GREET_CHANCE = 0.4;

// The fallback ask, used when the payload carries no useful detail of its
// own. When there IS a detail he says that instead — it is a better sentence
// than anything canned, because it was written for this exact situation.
const ASKS = {
  elicitation:        ['{name} has a question.', '{name} is asking you something.'],
  elicitation_dialog: ['{name} has a question for you.', '{name} wants to ask you something.'],
  permission:         ['{name} is asking permission.', '{name} wants your OK.'],
  idle_prompt:        ['{name} is waiting on you.', '{name} is waiting.'],
  agent_needs_input:  ['{name} needs your input.', '{name} needs you.'],
  unknown:            ['{name} wants something.', '{name} needs a look.'],
  error:              ['{name} hit an error.', 'Uh oh. {name} broke something.', '{name} fell over.'],
};

// `tool_name: scrap` is the shape the reducer builds for a permission ask
// (state.rs tool_detail). The scrap is the one-line description Claude writes
// for its own tool calls, so it is already a summary of the situation —
// turning it into a question is the whole trick. For tools whose scrap is a
// bare path instead of a description, the tool name supplies the verb.
const TOOL_VERB = {
  Edit: 'edit', Write: 'write', Read: 'read', NotebookEdit: 'edit',
  WebFetch: 'fetch', Glob: 'look for', Grep: 'search for',
};

// Cooldown, bucketed by STATE rather than by kind. The reducer can flap while
// a session list settles — and it flaps the *kind* too (idle_prompt ->
// permission -> elicitation on one session), so a per-kind cooldown lets the
// same settling burst speak three times. One bucket for every flavour of ask
// is what actually keeps him quiet. Rust already suppresses byte-identical
// payloads; this is the belt to that pair of braces.
const COOLDOWN_MS = { needs_input: 20000, error: 30000, done: 120000 };

// Finishing is NOT a rare event: the Stop hook fires every time Claude ends a
// turn, so `done` lands after every single reply and then decays to idle 10s
// later (state.rs DONE_TO_IDLE). Words there would be relentless — so a
// finish is a chirp, and only a job that actually took a while earns a
// spoken line.
const DONE_LINES = ['All done.', 'Finished.', 'That one is done.', 'All finished.', '{name} is done.'];
const LONG_TASK_MS = 90000;
const CHIRP_GAP_MS = 3000;

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
  chirp: true,
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

// pick, but never the same one twice running — repetition is what makes a
// canned line sound canned
const lastPicked = {};
function pick(arr, bucket) {
  if (arr.length < 2) return arr[0];
  let v;
  do { v = arr[Math.floor(Math.random() * arr.length)]; } while (bucket && v === lastPicked[bucket]);
  if (bucket) lastPicked[bucket] = v;
  return v;
}

// Turn the reducer's detail into something worth saying out loud.
// "PowerShell: Query live pet state"  -> "Can I query live pet state?"
// "Edit: index.html"                  -> "Can I edit index.html?"
// "Which approach should I use?"      -> unchanged, it is already a question
function phraseAsk(detail) {
  const raw = String(detail || '').trim();
  if (!raw) return '';
  const m = raw.match(/^([A-Z][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)*):\s*(.+)$/);
  if (m) {
    const tool = m[1];
    // a URL scrap must be caught before sanitise(), which flattens every URL
    // to the words "a link" — fine mid-sentence, nonsense as the object of a
    // question ("Can I a link?"). The host is what you actually want to hear.
    const url = m[2].match(/^https?:\/\/([^/\s]+)/);
    if (url) return `Can I ${TOOL_VERB[tool] || 'open'} ${url[1].replace(/^www\./, '')}?`;
    const scrap = cap(sanitise(m[2])).replace(/[.\s]+$/, '');
    if (!scrap) return '';
    // a scrap with spaces is a written description; a bare token is an object
    // the tool acts on, so the tool name has to supply the verb
    if (/\s/.test(scrap)) return 'Can I ' + scrap.charAt(0).toLowerCase() + scrap.slice(1) + '?';
    const verb = TOOL_VERB[tool];
    return verb ? `Can I ${verb} ${scrap}?` : `Can I run ${tool} on ${scrap}?`;
  }
  return cap(sanitise(raw));
}

// Compose what he should say for a reduced payload. Exported so the host can
// show it (and so it can be unit-checked without making a sound).
// `forceGreeting` is for the settings Test button, where you want to hear the
// whole shape rather than roll the dice on it.
function lineFor(state, kind, name, detail, forceGreeting) {
  const key = state === 'error' ? 'error' : (ASKS[kind] ? kind : 'unknown');
  const who = name || 'Claude';
  const body = settings.speakDetail ? phraseAsk(detail) : '';
  // the detail, when there is one, IS the ask — the canned line is only the
  // fallback for a payload that carries nothing useful
  const ask = body || pick(ASKS[key], 'ask:' + key).replace(/\{name\}/g, who);
  const greet = (forceGreeting || Math.random() < GREET_CHANCE) ? pick(GREETINGS, 'greet') + ' ' : '';
  return greet + ask;
}

// --- backends ---------------------------------------------------------

// The host listens so the body can bob while he talks (pet.setSpeaking).
// A plain callback rather than events: there is exactly one listener.
let speakingListener = null;
let speakingOffTimer = null;
function onSpeaking(fn) { speakingListener = fn; }
function setSpeaking(on) {
  clearTimeout(speakingOffTimer);
  if (speakingListener) speakingListener(!!on);
}
// the chirp has no onend of its own, so it books its own silence
function speakingFor(ms) {
  setSpeaking(true);
  speakingOffTimer = setTimeout(() => { if (speakingListener) speakingListener(false); }, ms);
}

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
    // the body bobs for exactly as long as the mouth is going
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    speechSynthesis.cancel(); // an alert supersedes whatever was mid-sentence
    speechSynthesis.speak(u);
  },
  stop() { try { speechSynthesis.cancel(); } catch {} setSpeaking(false); },
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

// --- chirp: the animalese burst ---------------------------------------
//
// A few short pitched blips, the Animal Crossing trick: no synthesizer, no
// samples, just an oscillator with a fast envelope. This is what he uses for
// things that happen CONSTANTLY — finishing a turn, taking a bite — where a
// spoken sentence would be unbearable but silence is a missed beat.
//
// Triangle rather than square: square alone reads as chiptune, triangle
// through a gentle lowpass sits closer to AC's warmth. ~5ms attack, ~70ms
// decay, ~55ms apart, a few cents of random detune so repeats aren't
// mechanical.
let audio = null;
function audioCtx() {
  if (!audio) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    audio = new C();
  }
  if (audio.state === 'suspended') audio.resume().catch(() => {});
  return audio;
}

// `shape` nudges the melody: 'up' for something finished well, 'flat' for a
// small acknowledgement like a bite.
function chirp(count = 3, shape = 'up') {
  if (!settings.enabled || !settings.chirp) return false;
  const ctx = audioCtx();
  if (!ctx) return false;
  // follows the voice pitch, so the chirp belongs to the same character
  const base = 300 * Math.max(0.6, Number(settings.pitch) || 1);
  let t = ctx.currentTime + 0.01;
  for (let i = 0; i < count; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    osc.type = 'triangle';
    const step = shape === 'up' ? i * 0.14 : (i % 2) * 0.07;
    const detune = 1 + (Math.random() - 0.5) * 0.04;
    osc.frequency.value = base * (1 + step) * detune;
    const peak = Math.max(0, Math.min(1, Number(settings.volume))) * 0.22;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.075);
    osc.connect(lp); lp.connect(gain); gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.09);
    t += 0.055;
  }
  speakingFor(count * 55 + 120); // bob along with the blips
  return true;
}

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

// A turn ended. `busyMs` is how long he was working beforehand — a long job
// gets a sentence, everything else gets the chirp.
let lastChirpAt = 0;
async function finished({ name, busyMs } = {}) {
  if (!settings.enabled) return null;
  const now = Date.now();
  if (busyMs >= LONG_TASK_MS && now - (lastSpokeAt.done || 0) >= COOLDOWN_MS.done) {
    lastSpokeAt.done = now;
    const text = pick(DONE_LINES, 'done').replace(/\{name\}/g, name || 'Claude');
    await say(text);
    return text;
  }
  if (now - lastChirpAt < CHIRP_GAP_MS) return null;
  lastChirpAt = now;
  return chirp(3, 'up') ? 'chirp' : null;
}

export {
  alert, finished, chirp, say, warm, stop, get, set, nudge, onSpeaking,
  lineFor, phraseAsk, sanitise, systemBackend, DEFAULTS, LIMITS,
};
