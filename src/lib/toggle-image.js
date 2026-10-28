// Draws the Auto Mode switch as a raw BGRA bitmap (the tray menu can only show images, not controls).
// Logical size 52x30; rendered at `scale` x, optionally centred on a square transparent canvas (`square`, for menus that force a square icon slot), with 4x supersampling for smooth edges.
const W = 52;
const H = 30;
const ON = [0x00, 0xac, 0xcd];
const OFF = [0x4a, 0x4a, 0x50];

function toggleBitmap(on, scale = 2, square = false) {
  const pw = Math.round(W * scale);
  const ph = Math.round(H * scale);
  const w = pw;
  const h = square ? pw : ph;
  const offX = 0;
  const offY = (h - ph) / 2;
  const ss = 4;
  const r = ph / 2;
  const knobR = r - 3 * scale;
  const knobX = offX + (on ? pw - r : r);
  const track = on ? ON : OFF;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let pill = 0;
      let knob = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          const cx = Math.min(Math.max(px, offX + r), offX + pw - r);
          if ((px - cx) ** 2 + (py - offY - r) ** 2 <= r * r) pill++;
          if ((px - knobX) ** 2 + (py - offY - r) ** 2 <= knobR * knobR) knob++;
        }
      }
      const n = ss * ss;
      const a = pill / n;
      const k = knob / n;
      const o = (y * w + x) * 4;
      // Premultiplied BGRA: knob (white) over track colour, scaled by the pill coverage.
      for (let c = 0; c < 3; c++) buf[o + c] = Math.round((track[2 - c] * (1 - k) + 255 * k) * a);
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return { buffer: buf, width: w, height: h, scaleFactor: scale };
}

module.exports = { toggleBitmap };
