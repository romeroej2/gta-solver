// Image capture + matching utilities.
// Matching: downscale to 32x32 grayscale, zero-mean/unit-variance normalize,
// score = Pearson correlation. Robust against brightness/contrast shifts that
// come with photographing a screen.

export const VEC_SIZE = 32;

export type Vec = Float32Array;

/**
 * Crop the region of the video that appears inside `rect` (in container CSS
 * pixels) when the video is rendered with object-fit: cover inside a
 * container of containerW x containerH.
 */
export function cropFromVideo(
  video: HTMLVideoElement,
  containerW: number,
  containerH: number,
  rect: { x: number; y: number; w: number; h: number },
  outSize = 512,
): HTMLCanvasElement {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  // object-fit: cover scale
  const scale = Math.max(containerW / vw, containerH / vh);
  const dispW = vw * scale;
  const dispH = vh * scale;
  const offX = (dispW - containerW) / 2;
  const offY = (dispH - containerH) / 2;

  const sx = (rect.x + offX) / scale;
  const sy = (rect.y + offY) / scale;
  const sw = rect.w / scale;
  const sh = rect.h / scale;

  const canvas = document.createElement("canvas");
  const aspect = rect.h / rect.w;
  canvas.width = outSize;
  canvas.height = Math.round(outSize * aspect);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Crop a relative sub-rectangle to an output canvas of given size. */
export function cropRegion(
  src: HTMLCanvasElement,
  fx: number,
  fy: number,
  fw: number,
  fh: number,
  ow: number,
  oh: number,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = ow;
  c.height = oh;
  c.getContext("2d")!.drawImage(
    src,
    fx * src.width,
    fy * src.height,
    fw * src.width,
    fh * src.height,
    0,
    0,
    ow,
    oh,
  );
  return c;
}

/** Crop a sub-rectangle (relative 0..1 coords) out of a canvas. */
export function cropCanvas(
  src: HTMLCanvasElement,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  outSize = 256,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = outSize;
  canvas.height = outSize;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(
    src,
    rx * src.width,
    ry * src.height,
    rw * src.width,
    rh * src.height,
    0,
    0,
    outSize,
    outSize,
  );
  return canvas;
}

/** Slice a components-panel canvas into rows x cols cell canvases (row-major). */
export function sliceGrid(
  panel: HTMLCanvasElement,
  rows: number,
  cols: number,
  innerFrac = 0.78,
): HTMLCanvasElement[] {
  const cells: HTMLCanvasElement[] = [];
  const cw = 1 / cols;
  const ch = 1 / rows;
  const margin = (1 - innerFrac) / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push(
        cropCanvas(
          panel,
          (c + margin) * cw,
          (r + margin) * ch,
          innerFrac * cw,
          innerFrac * ch,
        ),
      );
    }
  }
  return cells;
}

/** Slice a canvas into `rows` full-width horizontal strips. */
export function sliceRows(
  src: HTMLCanvasElement,
  rows: number,
  innerX = 0.8,
  innerY = 0.75,
): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  const rh = 1 / rows;
  const my = (1 - innerY) / 2;
  const mx = (1 - innerX) / 2;
  for (let r = 0; r < rows; r++) {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    c.getContext("2d")!.drawImage(
      src,
      mx * src.width,
      (r + my) * rh * src.height,
      innerX * src.width,
      innerY * rh * src.height,
      0,
      0,
      256,
      64,
    );
    out.push(c);
  }
  return out;
}

/**
 * Detect `want` uniformly spaced bordered row slots in a canvas.
 *
 * The slots' bright border lines span the full width, while slice content is
 * centered with dark flanks — so the per-row 25th-percentile brightness peaks
 * only at border lines. A uniform grid of want+1 lines is brute-force fitted
 * to maximize summed line brightness. Returns [y0, y1] fractions per slot, or
 * null when no line structure stands out (caller falls back to uniform
 * slicing).
 */
export function detectHBands(
  canvas: HTMLCanvasElement,
  want: number,
): [number, number][] | null {
  const W = 64;
  const H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0, W, H);
  const { data } = ctx.getImageData(0, 0, W, H);
  const prof = new Float32Array(H);
  const row = new Float32Array(W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      row[x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    prof[y] = [...row].sort((a, b) => a - b)[(W * 0.25) | 0];
  }
  // light smoothing so 1px-wide lines still register at nearby offsets
  const sm = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0,
      n = 0;
    for (let j = Math.max(0, y - 1); j <= Math.min(H - 1, y + 1); j++) {
      s += prof[j];
      n++;
    }
    sm[y] = s / n;
  }
  // fit score: bright at the want+1 line positions AND dark between them —
  // subtracting midpoints stops the fit from snapping onto title bars
  let bestY0 = 0;
  let bestPitch = 0;
  let bestScore = -Infinity;
  for (let y0 = 0; y0 < H * 0.3; y0 += 2) {
    const maxPitch = (H - 1 - y0) / want;
    for (let pitch = (H * 0.6) / want; pitch <= maxPitch; pitch += 1) {
      let s = 0;
      for (let k = 0; k <= want; k++) s += sm[Math.round(y0 + k * pitch)];
      for (let k = 0; k < want; k++) {
        s -= 0.9 * sm[Math.round(y0 + (k + 0.5) * pitch)];
      }
      if (s > bestScore) {
        bestScore = s;
        bestY0 = y0;
        bestPitch = pitch;
      }
    }
  }
  if (!isFinite(bestScore)) return null;
  // border lines must clearly outshine mid-slot flanks
  let lineAvg = 0;
  for (let k = 0; k <= want; k++) lineAvg += sm[Math.round(bestY0 + k * bestPitch)];
  lineAvg /= want + 1;
  let midAvg = 0;
  for (let k = 0; k < want; k++) {
    midAvg += sm[Math.round(bestY0 + (k + 0.5) * bestPitch)];
  }
  midAvg /= want;
  if (lineAvg < midAvg * 1.15 + 2) return null;
  const out: [number, number][] = [];
  for (let k = 0; k < want; k++) {
    out.push([(bestY0 + k * bestPitch) / H, (bestY0 + (k + 1) * bestPitch) / H]);
  }
  return out;
}

/* ---------- text-band segmentation (host IP grid) ---------- */

/**
 * Find bands of bright content along an axis (text lines on 'y', glyph
 * clusters on 'x') via a smoothed mean-brightness profile. Returns [f0, f1]
 * fractions per band.
 */
export function textBands(
  canvas: HTMLCanvasElement,
  axis: "x" | "y",
  smoothFrac = 0.008,
  minSizeFrac = 0.01,
): [number, number][] {
  const W = axis === "x" ? 768 : 96;
  const H = axis === "x" ? 96 : 768;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0, W, H);
  const { data } = ctx.getImageData(0, 0, W, H);
  const N = axis === "x" ? W : H;
  const M = axis === "x" ? H : W;
  const prof = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let j = 0; j < M; j++) {
      const idx = axis === "x" ? (j * W + i) * 4 : (i * W + j) * 4;
      // max channel: red text registers as bright as white text
      s += Math.max(data[idx], data[idx + 1], data[idx + 2]);
    }
    prof[i] = s / M;
  }
  const r = Math.max(1, Math.round(N * smoothFrac));
  const sm = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0,
      n = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(N - 1, i + r); j++) {
      s += prof[j];
      n++;
    }
    sm[i] = s / n;
  }
  const sorted = [...sm].sort((a, b) => a - b);
  const p20 = sorted[(N * 0.2) | 0];
  const p98 = sorted[(N * 0.98) | 0];
  if (p98 - p20 < 8) return [];
  const thr = p20 + 0.3 * (p98 - p20);
  const bands: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < N; i++) {
    const above = sm[i] > thr;
    if (above && start < 0) start = i;
    if ((!above || i === N - 1) && start >= 0) {
      if (i - start > N * minSizeFrac) bands.push([start / N, i / N]);
      start = -1;
    }
  }
  return bands;
}

/**
 * Group digit-level bands into 2-digit pair cells: drop dot/noise bands,
 * then merge neighbors whose gap is below half a digit width.
 */
export function groupPairBands(
  bands: [number, number][],
): [number, number][] {
  if (bands.length === 0) return [];
  const widths = bands.map(([a, b]) => b - a).sort((x, y) => x - y);
  const med = widths[(widths.length / 2) | 0];
  const keep = bands.filter(([a, b]) => b - a > 0.45 * med);
  const groups: [number, number][] = [];
  for (const band of keep) {
    const last = groups[groups.length - 1];
    if (last && band[0] - last[1] < 0.55 * med) last[1] = band[1];
    else groups.push([band[0], band[1]]);
  }
  return groups;
}

/**
 * Split a target-IP strip (N pairs separated by dots) into its pair spans:
 * cut at the widest gaps, then drop dot-sized trailing bands per group.
 */
export function splitIpPairs(
  bands: [number, number][],
  pairs = 4,
): [number, number][] | null {
  if (bands.length < pairs) return null;
  const widths = bands.map(([a, b]) => b - a).sort((x, y) => x - y);
  const med = widths[(widths.length / 2) | 0];
  const gaps: { i: number; g: number }[] = [];
  for (let i = 1; i < bands.length; i++) {
    gaps.push({ i, g: bands[i][0] - bands[i - 1][1] });
  }
  const cuts = gaps
    .sort((a, b) => b.g - a.g)
    .slice(0, pairs - 1)
    .map((c) => c.i)
    .sort((a, b) => a - b);
  const out: [number, number][] = [];
  let start = 0;
  for (const cut of [...cuts, bands.length]) {
    let group = bands.slice(start, cut);
    // drop leading/trailing dot-sized bands
    while (group.length > 1 && group[0][1] - group[0][0] < 0.5 * med) {
      group = group.slice(1);
    }
    while (
      group.length > 1 &&
      group[group.length - 1][1] - group[group.length - 1][0] < 0.5 * med
    ) {
      group = group.slice(0, -1);
    }
    if (group.length === 0) return null;
    out.push([group[0][0], group[group.length - 1][1]]);
    start = cut;
  }
  return out.length === pairs ? out : null;
}

/** Feature vector for a 2-digit pair glyph cluster. */
export function pairVec(canvas: HTMLCanvasElement): Float32Array {
  return toGrid(contentBBoxCrop(canvas, 0.03), 32, 20);
}

/** Similarity between two pair vectors. */
export function pairSim(a: Float32Array, b: Float32Array): number {
  return shiftSim(a, b, 32, 20, 3, 2);
}

/* ---------- seven-segment OCR ---------- */

// segment bitmask: a=1 b=2 c=4 d=8 e=16 f=32 g=64
// GTA's flip-clock font draws "1" as top + right side + bottom (mask 15).
const SEVEN_SEG: Record<number, number> = {
  63: 0, 6: 1, 15: 1, 91: 2, 79: 3, 102: 4, 109: 5, 125: 6, 7: 7, 127: 8,
  111: 9,
};

// Digit glyphs are classified by drawing each candidate shape and taking the
// best normalized correlation — far more tolerant of glow and blur than
// sampling segment zones.
let SEG_TEMPLATES: { digit: number; grid: Float32Array }[] | null = null;

const SEG_W = 24;
const SEG_H = 40;

function segTemplates() {
  if (SEG_TEMPLATES) return SEG_TEMPLATES;
  const masks: [number, number][] = Object.entries(SEVEN_SEG).map(([m, d]) => [
    +m,
    d,
  ]);
  // segment rects in a 60x100 cell: [x, y, w, h]
  const rects: [number, number, number, number][] = [
    [10, 2, 40, 12], // a
    [46, 8, 12, 38], // b
    [46, 54, 12, 38], // c
    [10, 86, 40, 12], // d
    [2, 54, 12, 38], // e
    [2, 8, 12, 38], // f
    [10, 44, 40, 12], // g
  ];
  SEG_TEMPLATES = masks.map(([mask, digit]) => {
    const c = document.createElement("canvas");
    c.width = 60;
    c.height = 100;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 60, 100);
    ctx.fillStyle = "#fff";
    // slight blur to mimic glow
    ctx.filter = "blur(2px)";
    rects.forEach((r, i) => {
      if (mask & (1 << i)) ctx.fillRect(...r);
    });
    return { digit, grid: toGrid(contentBBoxCrop(c, 0.02), SEG_W, SEG_H) };
  });
  return SEG_TEMPLATES;
}

/** Read a single 7-segment digit from a cell canvas. Null if blank/unclear. */
export function readSevenSegDigit(cell: HTMLCanvasElement): number | null {
  const W = 32;
  const H = 48;
  const g = toGrid(cell, W, H);
  const sorted = [...g].sort((a, b) => a - b);
  const p5 = sorted[(g.length * 0.05) | 0];
  const p95 = sorted[(g.length * 0.95) | 0];
  if (p95 - p5 < 15) return null; // no content
  // small shift search absorbs bbox misregistration; crop variants stay
  // mild — aggressive crops can shed an edge segment and turn one digit
  // into another (a cropped flip-clock "1" reads as "7")
  const bb = contentBBoxCrop(cell, 0.02);
  const fracs = [1.0, 0.92];
  const vars: Float32Array[] = [];
  for (const fx of fracs) {
    for (const fy of fracs) {
      vars.push(toGrid(cropFrac(bb, fx, fy), SEG_W, SEG_H));
    }
  }
  let best = -2;
  let digit: number | null = null;
  for (const t of segTemplates()) {
    let s = -2;
    for (const v of vars) {
      const sv = shiftSim(v, t.grid, SEG_W, SEG_H, 2, 3);
      if (sv > s) s = sv;
    }
    if (s > best) {
      best = s;
      digit = t.digit;
    }
  }
  if (best < 0.4) return null; // nothing digit-shaped
  // disambiguate pairs that differ by a single segment: sample that
  // segment's zone peak against a known-lit reference zone
  const zonePeak = (fx0: number, fy0: number, fx1: number, fy1: number) => {
    const gb = toGrid(bb, 40, 64);
    const vals: number[] = [];
    for (let y = Math.floor(fy0 * 64); y < fy1 * 64; y++) {
      for (let x = Math.floor(fx0 * 40); x < fx1 * 40; x++) {
        vals.push(gb[y * 40 + x]);
      }
    }
    vals.sort((a, b) => a - b);
    return vals[(vals.length * 0.85) | 0] ?? 0;
  };
  const aRef = () => zonePeak(0.3, 0.0, 0.7, 0.13); // top bar, lit in 1/7/8/9/0
  if (digit === 7 || digit === 1) {
    const d = zonePeak(0.3, 0.87, 0.7, 1.0);
    digit = d > 0.6 * aRef() ? 1 : 7;
  } else if (digit === 8 || digit === 9) {
    const e = zonePeak(0.0, 0.58, 0.25, 0.88);
    digit = e > 0.6 * aRef() ? 8 : 9;
  }
  return digit;
}

/**
 * Read a multi-digit 7-segment display region (digits only, no slot
 * borders). Digit count inferred from the lit bounding box aspect.
 */
export function readSevenSeg(
  canvas: HTMLCanvasElement,
  maxDigits: number,
): number | null {
  const W = 96;
  const H = 48;
  const g = toGrid(canvas, W, H);
  const sorted = [...g].sort((a, b) => a - b);
  const p5 = sorted[(g.length * 0.05) | 0];
  const p95 = sorted[(g.length * 0.95) | 0];
  if (p95 - p5 < 15) return null;
  const thr = p5 + 0.55 * (p95 - p5);
  let x0 = W,
    x1 = -1,
    y0 = H,
    y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (g[y * W + x] > thr) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const count = Math.max(1, Math.min(maxDigits, Math.round(bw / bh / 0.62)));
  let value = 0;
  for (let i = 0; i < count; i++) {
    const cell = cropCanvas(
      canvas,
      (x0 + (i * bw) / count) / W,
      Math.max(0, y0 - 1) / H,
      bw / count / W,
      Math.min(H, bh + 2) / H,
      64,
    );
    const d = readSevenSegDigit(cell);
    if (d === null) return null;
    value = value * 10 + d;
  }
  return value;
}

/** Read a bordered 3-slot 7-segment display (e.g. the TARGET readout). */
export function readSlottedDisplay(
  canvas: HTMLCanvasElement,
  slots: number,
): number | null {
  let value = 0;
  for (let i = 0; i < slots; i++) {
    const slot = cropCanvas(canvas, i / slots, 0, 1 / slots, 1, 160);
    const d = readBoxedDigit(slot);
    if (d === null) return null;
    value = value * 10 + d;
  }
  return value;
}

/** Read the single digit inside a bordered number box (with wire stubs). */
export function readBoxedDigit(cell: HTMLCanvasElement): number | null {
  const box = contentBBoxCrop(cell);
  const inner = cropFrac(box, 0.8, 0.8);
  return readSevenSegDigit(largestBlobCrop(inner, 0.9));
}

/** Normalized grayscale feature vector from a canvas. */
export function toVec(canvas: HTMLCanvasElement): Vec {
  const s = VEC_SIZE;
  const small = document.createElement("canvas");
  small.width = s;
  small.height = s;
  const ctx = small.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0, s, s);
  const { data } = ctx.getImageData(0, 0, s, s);
  const v = new Float32Array(s * s);
  let mean = 0;
  for (let i = 0; i < v.length; i++) {
    const g = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    v[i] = g;
    mean += g;
  }
  mean /= v.length;
  let sq = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] -= mean;
    sq += v[i] * v[i];
  }
  const std = Math.sqrt(sq / v.length) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= std;
  return v;
}

/** Pearson correlation between two normalized vectors (-1..1). */
export function similarity(a: Vec, b: Vec): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / a.length;
}

/** Raw grayscale grid (w x h) from a canvas, row-major. */
export function toGrid(
  canvas: HTMLCanvasElement,
  w = 64,
  h = 16,
): Float32Array {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) {
    g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return g;
}

function pearsonAt(
  a: Float32Array,
  b: Float32Array,
  w: number,
  h: number,
  dx: number,
  dy: number,
): number {
  const x0 = Math.max(0, dx);
  const x1 = Math.min(w, w + dx);
  const y0 = Math.max(0, dy);
  const y1 = Math.min(h, h + dy);
  const n = (x1 - x0) * (y1 - y0);
  if (n < 32) return -1;
  let sa = 0,
    sb = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sa += a[y * w + x];
      sb += b[(y - dy) * w + (x - dx)];
    }
  }
  const ma = sa / n;
  const mb = sb / n;
  let dot = 0,
    va = 0,
    vb = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const pa = a[y * w + x] - ma;
      const pb = b[(y - dy) * w + (x - dx)] - mb;
      dot += pa * pb;
      va += pa * pa;
      vb += pb * pb;
    }
  }
  const denom = Math.sqrt(va * vb);
  return denom > 0 ? dot / denom : -1;
}

/**
 * Crop a canvas to the bounding box of its bright content (ridges on dark
 * background), with a small pad. Normalizes framing differences between a
 * live capture and a reference image before comparison.
 */
export function contentBBoxCrop(
  src: HTMLCanvasElement,
  pad = 0.04,
): HTMLCanvasElement {
  const s = 96;
  const work = document.createElement("canvas");
  work.width = s;
  work.height = s;
  const ctx = work.getContext("2d")!;
  ctx.drawImage(src, 0, 0, s, s);
  const { data } = ctx.getImageData(0, 0, s, s);
  const g = new Float32Array(s * s);
  let mean = 0;
  for (let i = 0; i < g.length; i++) {
    g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    mean += g[i];
  }
  mean /= g.length;
  let sq = 0;
  for (let i = 0; i < g.length; i++) sq += (g[i] - mean) ** 2;
  const std = Math.sqrt(sq / g.length);
  const thr = mean + 0.5 * std;
  const colHits = new Array(s).fill(0);
  const rowHits = new Array(s).fill(0);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (g[y * s + x] > thr) {
        colHits[x]++;
        rowHits[y]++;
      }
    }
  }
  const min = s * 0.03;
  let x0 = colHits.findIndex((v) => v > min);
  let x1 = s - 1 - [...colHits].reverse().findIndex((v) => v > min);
  let y0 = rowHits.findIndex((v) => v > min);
  let y1 = s - 1 - [...rowHits].reverse().findIndex((v) => v > min);
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) return src;
  const px = ((x1 - x0) * pad) | 0;
  const py = ((y1 - y0) * pad) | 0;
  x0 = Math.max(0, x0 - px);
  x1 = Math.min(s - 1, x1 + px);
  y0 = Math.max(0, y0 - py);
  y1 = Math.min(s - 1, y1 + py);
  const out = document.createElement("canvas");
  out.width = 256;
  out.height = 256;
  out.getContext("2d")!.drawImage(
    src,
    (x0 / s) * src.width,
    (y0 / s) * src.height,
    ((x1 - x0 + 1) / s) * src.width,
    ((y1 - y0 + 1) / s) * src.height,
    0,
    0,
    256,
    256,
  );
  return out;
}

// Fingerprint descriptor: HOG (histogram of oriented gradients) over the
// bbox-normalized print. Ridge *orientation flow* survives rendering changes
// (thick glowing ridges on a photographed TV vs thin clean reference ridges,
// moiré, tint) that kill raw grayscale correlation.
const HOG_S = 96; // analysis resolution
const HOG_CELL = 8;
const HOG_NC = HOG_S / HOG_CELL; // 12x12 spatial cells
const HOG_BINS = 8; // orientation bins over 180°
const HOG_BLUR = 64; // downscale-to-N blur to suppress moiré

/**
 * Crop to the largest connected bright blob (after dilation). Robust way to
 * isolate a fingerprint from panel borders, title bars, and dot-grid
 * backgrounds that fool plain bounding-box thresholds.
 */
export function largestBlobCrop(
  src: HTMLCanvasElement,
  lineFrac = 0.55,
): HTMLCanvasElement {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, 0, 0, S, S);
  const { data } = ctx.getImageData(0, 0, S, S);
  const g = new Float32Array(S * S);
  for (let i = 0; i < g.length; i++) {
    g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const sorted = [...g].sort((a, b) => a - b);
  const p10 = sorted[(g.length * 0.1) | 0];
  const p99 = sorted[(g.length * 0.99) | 0];
  if (p99 - p10 < 10) return src;
  const thr = p10 + 0.55 * (p99 - p10);
  let mask = new Uint8Array(S * S);
  for (let i = 0; i < g.length; i++) mask[i] = g[i] > thr ? 1 : 0;
  // erase full-width / full-height structures (title bars, panel borders) so
  // they can't merge with the print blob during dilation
  for (let y = 0; y < S; y++) {
    let n = 0;
    for (let x = 0; x < S; x++) n += mask[y * S + x];
    if (n > S * lineFrac) for (let x = 0; x < S; x++) mask[y * S + x] = 0;
  }
  for (let x = 0; x < S; x++) {
    let n = 0;
    for (let y = 0; y < S; y++) n += mask[y * S + x];
    if (n > S * lineFrac) for (let y = 0; y < S; y++) mask[y * S + x] = 0;
  }
  // two rounds of 3x3 dilation to merge dashed ridges into one blob
  for (let round = 0; round < 2; round++) {
    const next = new Uint8Array(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let on = 0;
        for (let dy = -1; dy <= 1 && !on; dy++) {
          for (let dx = -1; dx <= 1 && !on; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < S && ny >= 0 && ny < S && mask[ny * S + nx]) on = 1;
          }
        }
        next[y * S + x] = on;
      }
    }
    mask = next;
  }
  // largest connected component (BFS)
  const seen = new Uint8Array(S * S);
  let best: { count: number; x0: number; x1: number; y0: number; y1: number } | null =
    null;
  const qx = new Int32Array(S * S);
  const qy = new Int32Array(S * S);
  for (let sy = 0; sy < S; sy++) {
    for (let sx = 0; sx < S; sx++) {
      if (!mask[sy * S + sx] || seen[sy * S + sx]) continue;
      let head = 0;
      let tail = 0;
      qx[tail] = sx;
      qy[tail++] = sy;
      seen[sy * S + sx] = 1;
      let count = 0;
      let x0 = sx,
        x1 = sx,
        y0 = sy,
        y1 = sy;
      while (head < tail) {
        const x = qx[head];
        const y = qy[head++];
        count++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (
            nx >= 0 && nx < S && ny >= 0 && ny < S &&
            mask[ny * S + nx] && !seen[ny * S + nx]
          ) {
            seen[ny * S + nx] = 1;
            qx[tail] = nx;
            qy[tail++] = ny;
          }
        }
      }
      if (!best || count > best.count) best = { count, x0, x1, y0, y1 };
    }
  }
  if (!best || best.count < S * S * 0.02) return src;
  // contract by the dilation growth (2 rounds x 1px) so the bbox matches the
  // true content extent — band slicing downstream is sensitive to this
  const pad = -2;
  const bx0 = Math.max(0, best.x0 - pad);
  const bx1 = Math.min(S - 1, best.x1 + pad);
  const by0 = Math.max(0, best.y0 - pad);
  const by1 = Math.min(S - 1, best.y1 + pad);
  const out = document.createElement("canvas");
  out.width = 256;
  out.height = 256;
  out.getContext("2d")!.drawImage(
    src,
    (bx0 / S) * src.width,
    (by0 / S) * src.height,
    ((bx1 - bx0 + 1) / S) * src.width,
    ((by1 - by0 + 1) / S) * src.height,
    0,
    0,
    256,
    256,
  );
  return out;
}

/**
 * Detect the cayo puzzle window in a loose capture and locate the rows panel
 * and the clone-target panel, anchored on the game's bright green/white UI —
 * so framing, screen size, and source don't need to be exact. Returns region
 * fractions of the frame, or null (caller falls back to fixed guide boxes).
 */
export function detectCayoRegions(frame: HTMLCanvasElement): {
  rows: { x: number; y: number; w: number; h: number };
  print: { x: number; y: number; w: number; h: number };
} | null {
  const W = 256;
  const H = Math.max(64, Math.round((W * frame.height) / frame.width));
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(frame, 0, 0, W, H);
  const { data } = ctx.getImageData(0, 0, W, H);
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    // green UI elements only — white is NOT safe as an anchor (desks,
    // keyboards, walls around the screen are white too)
    mask[i] = g > 60 && g > r + 15 && g > b + 15 ? 1 : 0;
  }
  const colDen = new Float32Array(W);
  const rowDen = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) {
        colDen[x] += 1 / H;
        rowDen[y] += 1 / W;
      }
    }
  }
  const firstAbove = (a: Float32Array, thr: number) => {
    for (let i = 0; i < a.length; i++) if (a[i] > thr) return i;
    return -1;
  };
  const lastAbove = (a: Float32Array, thr: number) => {
    for (let i = a.length - 1; i >= 0; i--) if (a[i] > thr) return i;
    return -1;
  };
  const x0 = firstAbove(colDen, 0.04);
  const x1 = lastAbove(colDen, 0.04);
  const y0 = firstAbove(rowDen, 0.04);
  const y1 = lastAbove(rowDen, 0.04);
  if (x0 < 0 || y0 < 0) return null;
  const ww = x1 - x0;
  const wh = y1 - y0;
  if (ww < W * 0.25 || wh < H * 0.15) return null; // window not found / too small
  // vertical split between the two panels: sparsest column in the middle band
  let xs = x0 + ww * 0.45;
  let minDen = Infinity;
  for (let x = (x0 + ww * 0.3) | 0; x <= x0 + ww * 0.6; x++) {
    if (colDen[x] < minDen) {
      minDen = colDen[x];
      xs = x;
    }
  }
  return {
    rows: {
      x: (x0 + ww * 0.02) / W,
      y: (y0 + wh * 0.25) / H,
      w: (xs - x0 - ww * 0.03) / W,
      h: (wh * 0.73) / H,
    },
    print: {
      x: (xs + ww * 0.01) / W,
      y: (y0 + wh * 0.26) / H,
      w: (x1 - xs - ww * 0.03) / W,
      h: (wh * 0.72) / H,
    },
  };
}

/** Feature vector for fingerprint matching (targets and components). */
export function toPrintGrid(canvas: HTMLCanvasElement): Float32Array {
  const bb = contentBBoxCrop(canvas);
  const t = document.createElement("canvas");
  t.width = HOG_BLUR;
  t.height = HOG_BLUR;
  t.getContext("2d")!.drawImage(bb, 0, 0, HOG_BLUR, HOG_BLUR);
  const g = toGrid(t, HOG_S, HOG_S);
  const feat = new Float32Array(HOG_NC * HOG_NC * HOG_BINS);
  for (let y = 1; y < HOG_S - 1; y++) {
    for (let x = 1; x < HOG_S - 1; x++) {
      const gx = g[y * HOG_S + x + 1] - g[y * HOG_S + x - 1];
      const gy = g[(y + 1) * HOG_S + x] - g[(y - 1) * HOG_S + x];
      const mag = Math.hypot(gx, gy);
      if (mag < 1) continue;
      let th = Math.atan2(gy, gx);
      if (th < 0) th += Math.PI;
      if (th >= Math.PI) th -= Math.PI;
      const bf = (th / Math.PI) * HOG_BINS;
      const b0 = Math.floor(bf) % HOG_BINS;
      const b1 = (b0 + 1) % HOG_BINS;
      const w1 = bf - Math.floor(bf);
      const cx = Math.min(HOG_NC - 1, (x / HOG_CELL) | 0);
      const cy = Math.min(HOG_NC - 1, (y / HOG_CELL) | 0);
      feat[(cy * HOG_NC + cx) * HOG_BINS + b0] += mag * (1 - w1);
      feat[(cy * HOG_NC + cx) * HOG_BINS + b1] += mag * w1;
    }
  }
  for (let c = 0; c < HOG_NC * HOG_NC; c++) {
    let n = 0;
    for (let b = 0; b < HOG_BINS; b++) n += feat[c * HOG_BINS + b] ** 2;
    n = Math.sqrt(n) || 1;
    for (let b = 0; b < HOG_BINS; b++) feat[c * HOG_BINS + b] /= n;
  }
  return feat;
}

/** Cosine similarity between HOG features, max over ±1 spatial-cell shifts. */
export function printSim(a: Float32Array, b: Float32Array): number {
  let best = -1;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      let dot = 0,
        na = 0,
        nb = 0;
      for (let cy = Math.max(0, dy); cy < Math.min(HOG_NC, HOG_NC + dy); cy++) {
        for (
          let cx = Math.max(0, dx);
          cx < Math.min(HOG_NC, HOG_NC + dx);
          cx++
        ) {
          for (let bn = 0; bn < HOG_BINS; bn++) {
            const va = a[(cy * HOG_NC + cx) * HOG_BINS + bn];
            const vb = b[((cy - dy) * HOG_NC + (cx - dx)) * HOG_BINS + bn];
            dot += va * vb;
            na += va * va;
            nb += vb * vb;
          }
        }
      }
      const s = dot / (Math.sqrt(na * nb) || 1);
      if (s > best) best = s;
    }
  }
  return best;
}

/** Centered crop of a canvas by fractions fx, fy. */
export function cropFrac(
  src: HTMLCanvasElement,
  fx: number,
  fy: number,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d")!.drawImage(
    src,
    ((1 - fx) / 2) * src.width,
    ((1 - fy) / 2) * src.height,
    fx * src.width,
    fy * src.height,
    0,
    0,
    c.width,
    c.height,
  );
  return c;
}

/**
 * Grids of a reference band at several centered crop fractions, to tolerate
 * the observed cell showing only an inner portion of the band (unknown zoom).
 */
export function gridVariants(src: HTMLCanvasElement): Float32Array[] {
  const fracs = [1.0, 0.85, 0.7];
  const out: Float32Array[] = [];
  for (const fx of fracs) {
    for (const fy of fracs) {
      out.push(toGrid(cropFrac(src, fx, fy)));
    }
  }
  return out;
}

/** Max Pearson correlation between two grids over small x/y shifts. */
export function shiftSim(
  a: Float32Array,
  b: Float32Array,
  w = 64,
  h = 16,
  maxDx = 4,
  maxDy = 2,
): number {
  let best = -1;
  for (let dy = -maxDy; dy <= maxDy; dy++) {
    for (let dx = -maxDx; dx <= maxDx; dx++) {
      const s = pearsonAt(a, b, w, h, dx, dy);
      if (s > best) best = s;
    }
  }
  return best;
}

export function canvasToDataURL(canvas: HTMLCanvasElement, size = 160): string {
  const out = document.createElement("canvas");
  out.width = size;
  out.height = Math.round((size * canvas.height) / canvas.width);
  out.getContext("2d")!.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.8);
}

export function dataURLToVec(url: string): Promise<Vec> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      resolve(toPrintGrid(canvas));
    };
    img.onerror = reject;
    img.src = url;
  });
}
