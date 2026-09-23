// The treat: a little biscuit that drops in beside the buddy when he's fed.
//
// Drawn on its OWN canvas, overlaid exactly on the pet canvas inside
// #pet-wrap, so it shares the buddy's 160x160 unit space and his
// scale * devicePixelRatio. Sharing the coordinate space (rather than
// positioning a small canvas of its own) is what keeps the biscuit on the
// ground line and at his side at every pet scale and every Windows display
// scaling — there is no second geometry to drift out of step with pet.js.
//
// It is decorative: pointer-events:none, never part of the hit region, and
// the host removes it on the first bite (see index.html's feed()).
//
// Char map: . transparent  # biscuit  % chip
'use strict';

const UNIT_W = 160, UNIT_H = 160;

// Canvas units per treat pixel. 2 units -> a 14-unit biscuit: small beside
// the buddy's 96-unit rest width, and still a whole number of device pixels
// per treat pixel through the same integer snap the app skin uses.
const CELL = 2;

// warm terracotta-adjacent biscuit tones: it belongs to the buddy's world,
// and carries no alarm colour (cuteness mandate)
const TREAT_PALETTE = { '#': '#b98a5e', '%': '#6b4a33' };

const TREAT = [
  '.#####.',
  '##%###%',
  '#######',
  '#%###%#',
  '#######',
  '##%####',
  '.#####.',
];

// landing squash: flatter and wider for one 60Hz beat, bottom-anchored and
// centred on the same spot, so the biscuit reads as having weight
const TREAT_SQUASH = [
  '..#####..',
  '.#%###%#.',
  '#########',
  '#%##%##%#',
  '.#######.',
];

const FALL_MS = 400;     // time from spawn to the ground line
const FALL_FROM = 40;    // units above the ground line it falls from
const SQUASH_MS = 67;    // one display-frame-aligned beat of landing squash

export class TreatSprite {
  constructor(pet, parent) {
    this.pet = pet;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'treat-canvas';
    parent.appendChild(this.canvas);
    this.off = document.createElement('canvas'); // native-res compositor
    this.droppedAt = 0;
    this.active = false;
    this._running = false;
    this._tick = this._tick.bind(this);
    // the buddy owns the scale; follow it rather than re-deriving one
    pet.on('scale', () => this.sync());
    this.sync();
  }

  // Match the pet canvas exactly: same unit box, same device pixels.
  sync() {
    const pet = this.pet;
    this.canvas.width = Math.round(UNIT_W * pet.k);
    this.canvas.height = Math.round(UNIT_H * pet.k);
    this.canvas.style.width = (UNIT_W * pet.scale) + 'px';
    this.canvas.style.height = (UNIT_H * pet.scale) + 'px';
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    if (!this.active) this._wipe();
  }

  // Start the fall. The host plays the eating clip when FALL_MS is up.
  drop() {
    this.droppedAt = performance.now();
    this.active = true;
    if (!this._running) {
      this._running = true;
      requestAnimationFrame(this._tick);
    }
  }

  // Taken in one bite: the biscuit simply vanishes.
  clear() {
    this.active = false;
    this._wipe();
  }

  _wipe() {
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _tick() {
    if (!this.active) { this._running = false; return; }
    this._draw();
    requestAnimationFrame(this._tick);
  }

  _draw() {
    const pet = this.pet;
    const el = performance.now() - this.droppedAt;
    const p = Math.min(1, el / FALL_MS);
    const landed = p >= 1;
    const squashing = landed && el < FALL_MS + SQUASH_MS;
    const frame = squashing ? TREAT_SQUASH : TREAT;
    const rows = frame.length, cols = frame[0].length;

    // At his side: the biscuit's centre sits on the rest rect's right edge —
    // clear of the legs, and well inside the strip the Tauri webview clips
    // off the canvas's right. IDLE_SIDE glances this way, so he spots it.
    const rest = pet.restBounds();
    const centreX = rest.x + rest.w;
    // gravity: accelerating fall (p^2) onto the ground line, then it rests
    const drop = landed ? 0 : FALL_FROM * (1 - p * p);
    const bottom = pet.style.ground - drop;
    this._wipe();
    this._paint(frame, centreX, bottom, cols, rows);
  }

  // Same integer-snapped paint path as the app skin (pet.js _paintFrame
  // 'int'): composite at native resolution, then one scaled drawImage at a
  // whole number of device pixels per treat pixel, so it can never blur or
  // drift out of the art style at fractional display scalings.
  //
  // The biscuit is anchored by its BOTTOM EDGE and its centre in DEVICE
  // pixels, not by a converted top-left: a whole number of device px per
  // treat pixel rarely divides the unit cell exactly (2 units at 0.5x on a
  // 150% display is 1.5 device px, which rounds to 2), and converting a
  // unit position instead would let that per-cell rounding accumulate and
  // sink the treat below the ground line. Anchoring the edge we care about
  // keeps it standing on the line at every scale; only its apparent size
  // moves by a rounding step, exactly as the sprite's does.
  _paint(frame, centreX, bottom, cols, rows) {
    const ctx = this.ctx, k = this.pet.k, off = this.off;
    if (off.width !== cols || off.height !== rows) {
      off.width = cols;
      off.height = rows;
    }
    const octx = off.getContext('2d');
    octx.clearRect(0, 0, cols, rows);
    for (let r = 0; r < rows; r++) {
      const row = frame[r];
      for (let c = 0; c < cols; c++) {
        const ch = row[c];
        if (ch === '.') continue;
        octx.fillStyle = TREAT_PALETTE[ch] || '#ff00ff';
        octx.fillRect(c, r, 1, 1);
      }
    }
    const cellPx = Math.max(1, Math.round(CELL * k));
    const w = cols * cellPx, h = rows * cellPx;
    const x = Math.round(centreX * k) - Math.round(w / 2);
    const y = Math.round(bottom * k) - h;
    ctx.drawImage(off, 0, 0, cols, rows, x, y, w, h);
  }
}

export { FALL_MS };
