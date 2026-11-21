// VELMORA — a travel poster for a place that isn't there.
// main.ts (Node 22, no dependencies, no network).
// Renders a 1024x1024 vintage-style travel poster entirely in code:
// a floating sky-harbour above a sea of clouds, with the place name
// set in big hand-drawn vector type. Writes /output/entry.png
// (or $MAKEFUN_OUTPUT_DIR/entry.png).
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// ---------------------------------------------------------------- PNG out
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

function encodePNG(w: number, h: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- Canvas
// Design space is 1024x1024; everything is rasterised at 2x supersampling
// and downsampled, which gives smooth edges without any font library.
type RGB = [number, number, number];

const DESIGN = 1024;
const SS = 2; // supersample factor
const PW = DESIGN * SS;

class Canvas {
  buf: Buffer;
  constructor() {
    this.buf = Buffer.alloc(PW * PW * 4);
  }
  // Blend one supersampled pixel.
  px(x: number, y: number, c: RGB, a: number): void {
    if (x < 0 || y < 0 || x >= PW || y >= PW || a <= 0) return;
    const i = (y * PW + x) * 4;
    const inv = 1 - a;
    this.buf[i] = Math.round(c[0] * a + this.buf[i] * inv);
    this.buf[i + 1] = Math.round(c[1] * a + this.buf[i + 1] * inv);
    this.buf[i + 2] = Math.round(c[2] * a + this.buf[i + 2] * inv);
    this.buf[i + 3] = 255;
  }
  fillRect(dx: number, dy: number, w: number, h: number, c: RGB, a = 1): void {
    const x0 = Math.max(0, Math.round(dx * SS));
    const y0 = Math.max(0, Math.round(dy * SS));
    const x1 = Math.min(PW, Math.round((dx + w) * SS));
    const y1 = Math.min(PW, Math.round((dy + h) * SS));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) this.px(x, y, c, a);
    }
  }
  // Vertical gradient over a design-space rect. stops: [pos 0..1, colour].
  vgrad(dx: number, dy: number, w: number, h: number, stops: [number, RGB][]): void {
    const x0 = Math.max(0, Math.round(dx * SS));
    const x1 = Math.min(PW, Math.round((dx + w) * SS));
    const y0 = Math.max(0, Math.round(dy * SS));
    const y1 = Math.min(PW, Math.round((dy + h) * SS));
    for (let y = y0; y < y1; y++) {
      const t = (y / SS - dy) / h;
      let s0 = stops[0];
      let s1 = stops[stops.length - 1];
      for (let i = 0; i < stops.length - 1; i++) {
        if (t >= stops[i][0] && t <= stops[i + 1][0]) {
          s0 = stops[i];
          s1 = stops[i + 1];
          break;
        }
      }
      const f = s1[0] === s0[0] ? 0 : (t - s0[0]) / (s1[0] - s0[0]);
      const col: RGB = [
        Math.round(s0[1][0] + (s1[1][0] - s0[1][0]) * f),
        Math.round(s0[1][1] + (s1[1][1] - s0[1][1]) * f),
        Math.round(s0[1][2] + (s1[1][2] - s0[1][2]) * f),
      ];
      for (let x = x0; x < x1; x++) this.px(x, y, col, 1);
    }
  }
  // Scanline polygon fill. pts in design coordinates.
  poly(pts: [number, number][], c: RGB, a = 1): void {
    const P = pts.map(([x, y]) => [x * SS, y * SS] as [number, number]);
    let minY = PW;
    let maxY = -1;
    for (const [, y] of P) {
      minY = Math.min(minY, Math.floor(y));
      maxY = Math.max(maxY, Math.ceil(y));
    }
    minY = Math.max(0, minY);
    maxY = Math.min(PW - 1, maxY);
    for (let y = minY; y <= maxY; y++) {
      const xs: number[] = [];
      for (let i = 0; i < P.length; i++) {
        const [x0, y0] = P[i];
        const [x1, y1] = P[(i + 1) % P.length];
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
          xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.ceil(xs[k]));
        const x1 = Math.min(PW - 1, Math.floor(xs[k + 1]));
        for (let x = x0; x <= x1; x++) this.px(x, y, c, a);
      }
    }
  }
  circle(cx: number, cy: number, r: number, c: RGB, a = 1): void {
    this.ellipse(cx, cy, r, r, c, a);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1): void {
    const x0 = Math.max(0, Math.floor((cx - rx) * SS));
    const x1 = Math.min(PW - 1, Math.ceil((cx + rx) * SS));
    const y0 = Math.max(0, Math.floor((cy - ry) * SS));
    const y1 = Math.min(PW - 1, Math.ceil((cy + ry) * SS));
    const ccx = cx * SS;
    const ccy = cy * SS;
    const rrx = rx * SS;
    const rry = ry * SS;
    for (let y = y0; y <= y1; y++) {
      const dy = (y - ccy) / rry;
      if (dy * dy > 1) continue;
      const half = rrx * Math.sqrt(1 - dy * dy);
      for (let x = Math.max(x0, Math.ceil(ccx - half)); x <= Math.min(x1, Math.floor(ccx + half)); x++) {
        this.px(x, y, c, a);
      }
    }
  }
  // Thick line with round ends, in design coordinates.
  line(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a = 1): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) {
      this.circle(x0, y0, w / 2, c, a);
      return;
    }
    const nx = (-dy / len) * (w / 2);
    const ny = (dx / len) * (w / 2);
    this.poly(
      [
        [x0 + nx, y0 + ny],
        [x1 + nx, y1 + ny],
        [x1 - nx, y1 - ny],
        [x0 - nx, y0 - ny],
      ],
      c,
      a,
    );
    this.circle(x0, y0, w / 2, c, a);
    this.circle(x1, y1, w / 2, c, a);
  }
  // Polyline stroke with round joints.
  stroke(pts: [number, number][], w: number, c: RGB, a = 1): void {
    for (let i = 0; i + 1 < pts.length; i++) {
      this.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, c, a);
    }
  }
  // Downsample the 2x buffer to 1024x1024 RGBA.
  toRGBA(): Buffer {
    const out = Buffer.alloc(DESIGN * DESIGN * 4);
    for (let y = 0; y < DESIGN; y++) {
      for (let x = 0; x < DESIGN; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const i = ((y * SS + sy) * PW + (x * SS + sx)) * 4;
            r += this.buf[i];
            g += this.buf[i + 1];
            b += this.buf[i + 2];
          }
        }
        const o = (y * DESIGN + x) * 4;
        const n = SS * SS;
        out[o] = Math.round(r / n);
        out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(b / n);
        out[o + 3] = 255;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- Type
// A single-stroke geometric display face, drawn by code so the lettering
// is always crisp. Glyphs live in a 100 x 140 box (baseline y = 140).
// Each glyph is a list of strokes; each stroke a list of [x, y] points.
type Stroke = [number, number][];
const GLYPHS: Record<string, Stroke[]> = {
  A: [[[5, 140], [50, 5], [95, 140]], [[26, 96], [74, 96]]],
  B: [[[8, 140], [8, 5], [60, 5], [88, 26], [88, 52], [60, 70], [8, 70]], [[60, 70], [90, 88], [90, 118], [60, 140], [8, 140]]],
  C: [[[92, 22], [70, 5], [28, 5], [8, 30], [8, 110], [28, 140], [70, 140], [92, 120]]],
  D: [[[8, 5], [55, 5], [88, 32], [88, 108], [55, 140], [8, 140]]],
  E: [[[90, 5], [8, 5], [8, 140], [90, 140]], [[8, 72], [64, 72]]],
  F: [[[8, 140], [8, 5], [90, 5]], [[8, 72], [64, 72]]],
  G: [[[92, 26], [70, 5], [28, 5], [8, 28], [8, 112], [28, 140], [70, 140], [92, 116], [92, 82], [58, 82]]],
  H: [[[8, 5], [8, 140]], [[92, 5], [92, 140]], [[8, 72], [92, 72]]],
  I: [[[50, 5], [50, 140]], [[26, 5], [74, 5]], [[26, 140], [74, 140]]],
  J: [[[70, 5], [70, 112], [54, 140], [30, 140], [14, 124]]],
  K: [[[8, 5], [8, 140]], [[90, 5], [8, 72], [90, 140]]],
  L: [[[8, 5], [8, 140], [90, 140]]],
  M: [[[8, 140], [8, 5], [50, 96], [92, 5], [92, 140]]],
  N: [[[8, 140], [8, 5], [92, 140], [92, 5]]],
  O: [[[50, 5], [78, 12], [92, 36], [92, 104], [78, 128], [50, 140], [22, 128], [8, 104], [8, 36], [22, 12], [50, 5]]],
  P: [[[8, 140], [8, 5], [62, 5], [90, 28], [90, 54], [62, 72], [8, 72]]],
  Q: [[[50, 5], [78, 12], [92, 36], [92, 104], [78, 128], [50, 140], [22, 128], [8, 104], [8, 36], [22, 12], [50, 5]], [[68, 104], [96, 140]]],
  R: [[[8, 140], [8, 5], [62, 5], [90, 28], [90, 54], [62, 72], [8, 72]], [[62, 72], [92, 140]]],
  S: [[[88, 26], [70, 5], [30, 5], [10, 26], [10, 54], [30, 72], [70, 72], [90, 90], [90, 114], [70, 140], [30, 140], [12, 118]]],
  T: [[[8, 5], [92, 5]], [[50, 5], [50, 140]]],
  U: [[[8, 5], [8, 110], [26, 140], [74, 140], [92, 110], [92, 5]]],
  V: [[[5, 5], [50, 140], [95, 5]]],
  W: [[[5, 5], [25, 140], [50, 80], [75, 140], [95, 5]]],
  X: [[[8, 5], [92, 140]], [[92, 5], [8, 140]]],
  Y: [[[8, 5], [50, 70], [92, 5]], [[50, 70], [50, 140]]],
  Z: [[[8, 5], [92, 5], [8, 140], [92, 140]]],
  "·": [[[50, 62], [50, 66]]],
  ".": [[[50, 128], [50, 132]]],
  "—": [[[10, 70], [90, 70]]],
  "-": [[[22, 70], [78, 70]]],
};

const ADVANCE = 104; // glyph advance in font units (100 wide + 4 gap)

// Width of a string at a given cap height and extra tracking (design px).
function textWidth(text: string, height: number, tracking: number): number {
  const s = height / 140;
  let w = 0;
  for (const ch of text) {
    w += ch === " " ? ADVANCE * 0.55 * s : (ADVANCE * s + tracking);
  }
  return w - tracking;
}

// Draw centred text; (cx, top) is the top-centre of the cap-height box.
function drawText(
  cv: Canvas,
  text: string,
  cx: number,
  top: number,
  height: number,
  weight: number,
  c: RGB,
  tracking = 0,
  a = 1,
): void {
  const s = height / 140;
  const w = textWidth(text, height, tracking);
  let x = cx - w / 2;
  for (const ch of text) {
    if (ch === " ") {
      x += ADVANCE * 0.55 * s;
      continue;
    }
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (const stroke of glyph) {
        const pts = stroke.map(([gx, gy]) => [x + gx * s, top + gy * s] as [number, number]);
        cv.stroke(pts, weight, c, a);
      }
    }
    x += ADVANCE * s + tracking;
  }
}

// ---------------------------------------------------------------- Poster
// VELMORA — a floating sky-harbour above a sea of clouds. Glass-sailed
// ships dock at sky-piers; a lighthouse keeps the cloud-sea lanes lit;
// the sun sets behind it all. Vintage flat-vector travel-poster style.
const INK: RGB = [20, 31, 56];
const CREAM: RGB = [255, 243, 214];
const GOLD: RGB = [247, 200, 115];
const SUN: RGB = [255, 217, 122];
const TERRA: RGB = [198, 91, 63];
const ROCK: RGB = [74, 46, 80];
const WOOD: RGB = [107, 74, 53];

function render(): Buffer {
  const cv = new Canvas();

  // Sky: dusk gradient, deep indigo down to a gold horizon.
  cv.vgrad(0, 0, 1024, 880, [
    [0, [20, 31, 58]],
    [0.38, [46, 83, 120]],
    [0.6, [185, 126, 99]],
    [0.75, [240, 163, 92]],
    [0.86, [247, 200, 115]],
  ]);

  // Early stars in the upper sky.
  const stars: [number, number, number][] = [
    [80, 80, 3], [150, 140, 2], [900, 90, 3], [950, 180, 2],
    [60, 300, 2], [860, 150, 2], [420, 70, 2], [700, 120, 3],
  ];
  for (const [x, y, r] of stars) cv.circle(x, y, r, CREAM, 0.75);

  // Low sun, right of the island.
  cv.circle(820, 520, 160, [255, 190, 110], 0.12);
  cv.circle(820, 520, 120, [255, 200, 120], 0.22);
  cv.circle(820, 520, 85, SUN, 1);

  // A few drifting cloud puffs in the sky.
  const puffs: [number, number, number, number][] = [
    [300, 380, 70, 20], [650, 250, 90, 24], [880, 350, 60, 18], [120, 470, 80, 20],
  ];
  for (const [x, y, rx, ry] of puffs) cv.ellipse(x, y, rx, ry, [255, 246, 224], 0.45);

  // Airship drifting in from the left.
  cv.ellipse(215, 285, 90, 40, TERRA, 1);
  cv.ellipse(215, 278, 70, 26, [214, 110, 80], 1);
  cv.ellipse(215, 285, 88, 38, [0, 0, 0], 0); // (kept for symmetry of the shape)
  cv.fillRect(190, 325, 50, 18, [58, 36, 54], 1);
  cv.line(200, 322, 192, 306, 3, [58, 36, 54], 1);
  cv.line(230, 322, 238, 306, 3, [58, 36, 54], 1);
  cv.poly([[300, 272], [318, 285], [300, 298]], TERRA, 1);
  cv.circle(205, 336, 3, GOLD, 1);
  cv.circle(225, 336, 3, GOLD, 1);

  // Birds.
  const birds: [number, number][] = [[350, 300], [420, 260], [620, 330], [700, 280]];
  for (const [x, y] of birds) {
    cv.stroke([[x, y], [x + 11, y - 8], [x + 22, y]], 4, INK, 0.85);
  }

  // Distant cloud band behind the island.
  cv.ellipse(180, 720, 200, 45, [217, 168, 160], 0.7);
  cv.ellipse(700, 700, 240, 50, [232, 183, 160], 0.7);
  cv.ellipse(950, 730, 180, 45, [217, 168, 160], 0.7);

  // --- The floating island -------------------------------------------------
  // Rock: a tapered underside hanging above the cloud sea.
  cv.poly([[285, 600], [740, 600], [600, 800], [512, 872], [425, 800]], ROCK, 1);
  // Strata lines on the rock face.
  cv.stroke([[330, 665], [680, 665]], 4, [58, 36, 54], 0.6);
  cv.stroke([[380, 730], [640, 730]], 4, [58, 36, 54], 0.6);
  cv.stroke([[440, 795], [580, 795]], 4, [58, 36, 54], 0.6);
  // Grassy rim along the plateau.
  cv.fillRect(285, 588, 455, 12, [122, 143, 79], 1);
  // Waterfall pouring off the island into the clouds.
  cv.poly([[572, 790], [606, 790], [600, 862], [580, 862]], [220, 238, 242], 0.95);
  cv.ellipse(590, 860, 32, 10, [255, 255, 255], 0.9);

  // Lighthouse tower.
  cv.poly([[468, 588], [472, 430], [528, 430], [532, 588]], [245, 230, 200], 1);
  cv.fillRect(462, 418, 76, 14, [58, 36, 54], 1);
  cv.fillRect(478, 398, 44, 20, SUN, 1);
  cv.line(478, 398, 478, 418, 3, [58, 36, 54], 1);
  cv.line(522, 398, 522, 418, 3, [58, 36, 54], 1);
  cv.ellipse(500, 398, 30, 18, TERRA, 1);
  cv.line(500, 380, 500, 350, 4, [58, 36, 54], 1);
  cv.poly([[500, 350], [530, 359], [500, 368]], TERRA, 1);
  // The lighthouse beam, sweeping up to the right.
  cv.poly([[500, 408], [930, 285], [930, 335]], GOLD, 0.16);
  // Tower windows.
  cv.fillRect(492, 470, 16, 22, INK, 1);
  cv.fillRect(492, 520, 16, 22, INK, 1);

  // Domed houses.
  cv.ellipse(370, 542, 42, 36, TERRA, 1);
  cv.fillRect(330, 540, 80, 48, [245, 230, 200], 1);
  cv.fillRect(362, 562, 16, 26, INK, 1);
  cv.fillRect(342, 556, 12, 12, INK, 1);
  cv.fillRect(386, 556, 12, 12, INK, 1);
  cv.ellipse(650, 554, 36, 30, TERRA, 1);
  cv.fillRect(615, 552, 70, 36, [245, 230, 200], 1);
  cv.fillRect(643, 566, 14, 22, INK, 1);
  cv.fillRect(624, 562, 10, 10, INK, 1);

  // Trees.
  cv.line(300, 588, 300, 560, 5, WOOD, 1);
  cv.circle(300, 548, 18, [95, 125, 79], 1);
  cv.circle(286, 558, 12, [95, 125, 79], 1);
  cv.line(708, 588, 708, 562, 5, WOOD, 1);
  cv.circle(708, 550, 16, [95, 125, 79], 1);

  // Sky-piers.
  cv.fillRect(150, 600, 135, 10, WOOD, 1);
  cv.fillRect(160, 610, 6, 28, [58, 36, 54], 1);
  cv.fillRect(240, 610, 6, 28, [58, 36, 54], 1);
  cv.line(152, 600, 152, 588, 4, [58, 36, 54], 1);
  cv.circle(152, 584, 6, GOLD, 1);
  cv.fillRect(740, 600, 140, 10, WOOD, 1);
  cv.fillRect(760, 610, 6, 28, [58, 36, 54], 1);
  cv.fillRect(850, 610, 6, 28, [58, 36, 54], 1);
  cv.line(878, 600, 878, 588, 4, [58, 36, 54], 1);
  cv.circle(878, 584, 6, GOLD, 1);

  // Glass-sailed ships moored at the piers.
  // Left ship.
  cv.poly([[185, 612], [265, 612], [250, 640], [200, 640]], [58, 36, 54], 1);
  cv.line(225, 612, 225, 462, 5, [58, 36, 54], 1);
  cv.poly([[225, 470], [225, 600], [288, 600]], [255, 233, 168], 0.9);
  cv.poly([[225, 478], [225, 598], [168, 600]], [255, 250, 235], 0.85);
  cv.poly([[225, 462], [248, 470], [225, 478]], TERRA, 1);
  // Right ship, sails glowing against the sun.
  cv.poly([[800, 612], [872, 612], [858, 638], [814, 638]], [58, 36, 54], 1);
  cv.line(836, 612, 836, 480, 5, [58, 36, 54], 1);
  cv.poly([[836, 488], [836, 600], [790, 600]], [255, 233, 168], 0.9);
  cv.poly([[836, 494], [836, 598], [876, 600]], [255, 250, 235], 0.85);
  cv.poly([[836, 480], [859, 488], [836, 496]], TERRA, 1);

  // --- The sea of clouds, front layer --------------------------------------
  cv.ellipse(250, 810, 260, 60, [255, 233, 196], 1);
  cv.ellipse(700, 830, 280, 65, [255, 233, 196], 1);
  cv.ellipse(950, 810, 200, 55, [255, 233, 196], 1);
  cv.ellipse(120, 860, 220, 50, [242, 185, 138], 1);
  cv.ellipse(560, 865, 260, 55, [242, 185, 138], 1);
  cv.ellipse(900, 870, 220, 50, [242, 185, 138], 1);
  cv.ellipse(420, 845, 180, 40, [255, 246, 224], 0.9);
  cv.ellipse(820, 850, 160, 35, [255, 246, 224], 0.9);

  // --- Type ------------------------------------------------------------------
  // The place name, big across the top sky, with a soft shadow.
  drawText(cv, "VELMORA", 518, 72, 128, 15, INK, 4, 0.55);
  drawText(cv, "VELMORA", 512, 64, 128, 15, CREAM, 4, 1);
  // Sub-line: what it is.
  drawText(cv, "SKY HARBOUR · ABOVE THE CLOUDS", 512, 216, 27, 5, GOLD, 10, 1);

  // --- Bottom band: the promise ---------------------------------------------
  cv.fillRect(0, 880, 1024, 144, INK, 1);
  cv.fillRect(0, 880, 1024, 4, GOLD, 1);
  drawText(cv, "WHERE THE SEA LEARNED TO FLY", 512, 928, 40, 7, CREAM, 4, 1);
  cv.circle(452, 996, 4, GOLD, 1);
  cv.circle(512, 996, 4, GOLD, 1);
  cv.circle(572, 996, 4, GOLD, 1);

  // Thin cream frame around the whole poster.
  cv.line(18, 18, 1006, 18, 6, CREAM, 0.9);
  cv.line(18, 1006, 1006, 1006, 6, CREAM, 0.9);
  cv.line(18, 18, 18, 1006, 6, CREAM, 0.9);
  cv.line(1006, 18, 1006, 1006, 6, CREAM, 0.9);

  return encodePNG(DESIGN, DESIGN, cv.toRGBA());
}

function main(): void {
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const png = render();
  const outPath = path.join(outDir, "entry.png");
  fs.writeFileSync(outPath, png);
  console.log(`wrote ${outPath} ${png.length} bytes`);
}

main();
