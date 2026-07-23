import { useCallback, useEffect, useRef, useState } from "react";
import {
  canvasToDataURL,
  contentBBoxCrop,
  cropFromVideo,
  cropRegion,
  detectCayoRegions,
  detectHBands,
  largestBlobCrop,
  groupPairBands,
  gridVariants,
  pairSim,
  pairVec,
  printSim,
  readBoxedDigit,
  readSlottedDisplay,
  shiftSim,
  splitIpPairs,
  textBands,
  sliceGrid,
  sliceRows,
  toGrid,
  toPrintGrid,
} from "./lib/image";
import { loadRefs, type LoadedRef } from "./lib/store";

const ROWS = 4;
const COLS = 2;
// Winner must beat the runner-up print by this combined-score margin,
// otherwise the result is flagged as low confidence.
const MARGIN_THRESHOLD = 0.05;

type Tab = "solve" | "cayo" | "math" | "host";

/** Sub-regions of the casino capture frame (fractions of the guide box),
 * matching the in-game puzzle window proportions. */
const BOX_COMPS = { x: 0.09, y: 0.19, w: 0.225, h: 0.62 };
const BOX_TARGET = { x: 0.45, y: 0.06, w: 0.43, h: 0.64 };
const CASINO_FRAME_ASPECT = 0.77; // whole puzzle window, h/w

interface SubBox {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

/* ---------------- Camera ---------------- */

interface CameraProps {
  guideAspect: number; // height / width of the guide box
  label: string;
  subBoxes?: SubBox[];
  gridRows?: number; // dashed row hints inside the guide
  onCapture: (crop: HTMLCanvasElement) => void;
}

function Camera({ guideAspect, label, subBoxes, gridRows, onCapture }: CameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [rect, setRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch {
        setError("Camera unavailable — use the photo button below.");
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const guideRect = useCallback(() => {
    const el = containerRef.current!;
    const W = el.clientWidth;
    const H = el.clientHeight;
    let w = W * 0.9;
    let h = w * guideAspect;
    if (h > H * 0.86) {
      h = H * 0.86;
      w = h / guideAspect;
    }
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }, [guideAspect]);

  // The overlay is positioned from the SAME rect used for capture — any
  // mismatch between the drawn guide and the cropped region breaks alignment.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setRect(guideRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [guideRect]);

  const capture = () => {
    const video = videoRef.current;
    const el = containerRef.current;
    if (!video || !el || !video.videoWidth) return;
    onCapture(
      cropFromVideo(video, el.clientWidth, el.clientHeight, guideRect(), 1024),
    );
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      // Center crop of the photo with the guide aspect, covering 90% of the
      // shorter fitting dimension.
      let w = img.width * 0.9;
      let h = w * guideAspect;
      if (h > img.height * 0.9) {
        h = img.height * 0.9;
        w = h / guideAspect;
      }
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = Math.round(1024 * guideAspect);
      canvas
        .getContext("2d")!
        .drawImage(
          img,
          (img.width - w) / 2,
          (img.height - h) / 2,
          w,
          h,
          0,
          0,
          canvas.width,
          canvas.height,
        );
      URL.revokeObjectURL(img.src);
      onCapture(canvas);
    };
    img.src = URL.createObjectURL(file);
    e.target.value = "";
  };

  return (
    <div className="camera-wrap">
      <div className="camera" ref={containerRef}>
        <video ref={videoRef} playsInline muted autoPlay />
        {rect && (
        <div
          className="guide"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          {gridRows && (
            <div
              className="guide-grid"
              style={{ gridTemplateRows: `repeat(${gridRows}, 1fr)` }}
            >
              {Array.from({ length: gridRows }).map((_, i) => (
                <div key={i} />
              ))}
            </div>
          )}
          {subBoxes?.map((b, i) => (
            <div
              key={i}
              className="sub-box"
              style={{
                left: `${b.x * 100}%`,
                top: `${b.y * 100}%`,
                width: `${b.w * 100}%`,
                height: `${b.h * 100}%`,
              }}
            >
              <span>{b.label}</span>
            </div>
          ))}
        </div>
        )}
        <div className="guide-label">{label}</div>
        {error && <div className="cam-error">{error}</div>}
      </div>
      <div className="cam-actions">
        <button className="shutter" onClick={capture} aria-label="Capture" />
        <button className="alt" onClick={() => fileRef.current?.click()}>
          📷 photo
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={onFile}
        />
      </div>
    </div>
  );
}

/* ---------------- Casino ---------------- */

interface SolveResult {
  slot: number;
  combined: number;
  margin: number; // combined-score lead over the runner-up print
  picks: number[]; // winning cell indices (row-major)
  cellImgs: string[];
  comps: string[]; // matched print's reference component images
}

/**
 * Decide print + correct cells. The print is chosen by combined evidence:
 * greedy assignment of its 4 reference components to distinct cells (strong
 * signal) plus target-print similarity (weak signal).
 */
function solveCasino(
  refs: LoadedRef[],
  targetVec: Float32Array,
  cells: HTMLCanvasElement[],
): SolveResult {
  const cellVecs = cells.map((c) => toPrintGrid(c));
  const scored = refs.map((r) => {
    const tSim = printSim(targetVec, r.targetVec);
    const pairs: [number, number, number][] = [];
    cellVecs.forEach((v, ci) =>
      r.compVecs.forEach((cv, ki) => pairs.push([printSim(v, cv), ci, ki])),
    );
    pairs.sort((a, b) => b[0] - a[0]);
    const usedC = new Set<number>();
    const usedK = new Set<number>();
    const picks: number[] = [];
    let sum = 0;
    for (const [s, ci, ki] of pairs) {
      if (usedC.has(ci) || usedK.has(ki)) continue;
      usedC.add(ci);
      usedK.add(ki);
      picks.push(ci);
      sum += s;
      if (picks.length === 4) break;
    }
    return { r, combined: 0.3 * tSim + 0.7 * (sum / 4), picks };
  });
  scored.sort((a, b) => b.combined - a.combined);
  const win = scored[0];
  return {
    slot: win.r.slot,
    combined: win.combined,
    margin: win.combined - (scored[1]?.combined ?? 0),
    picks: win.picks.sort((a, b) => a - b),
    cellImgs: cells.map((c) => canvasToDataURL(c, 96)),
    comps: win.r.comps,
  };
}

function Solve() {
  const [result, setResult] = useState<SolveResult | null>(null);

  const onShot = async (frame: HTMLCanvasElement) => {
    // answer sheet loads on first use, not on page load
    const refs = await loadRefs();
    const targetC = cropRegion(
      frame,
      BOX_TARGET.x,
      BOX_TARGET.y,
      BOX_TARGET.w,
      BOX_TARGET.h,
      512,
      640,
    );
    const compsC = cropRegion(
      frame,
      BOX_COMPS.x,
      BOX_COMPS.y,
      BOX_COMPS.w,
      BOX_COMPS.h,
      512,
      1024,
    );
    const cells = sliceGrid(compsC, ROWS, COLS);
    setResult(solveCasino(refs, toPrintGrid(targetC), cells));
  };

  return (
    <div className="solve">
      {!result && (
        <Camera
          guideAspect={CASINO_FRAME_ASPECT}
          label="Fit the puzzle window in the frame — squares & print in their boxes"
          subBoxes={[
            { ...BOX_COMPS, label: "8 squares" },
            { ...BOX_TARGET, label: "big print" },
          ]}
          onCapture={onShot}
        />
      )}

      {result && (
        <div className="result">
          {result.margin < MARGIN_THRESHOLD ? (
            <p className="warn">
              Low confidence (margin {result.margin.toFixed(2)}) — best guess
              shown. Retake if wrong.
            </p>
          ) : (
            <p className="ok">
              Print #{result.slot} · margin {result.margin.toFixed(2)} — tap
              the highlighted squares:
            </p>
          )}
          <div className="cell-grid">
            {result.cellImgs.map((src, i) => (
              <div
                key={i}
                className={result.picks.includes(i) ? "cell picked" : "cell"}
              >
                <img src={src} alt={`cell ${i + 1}`} />
              </div>
            ))}
          </div>
          <details>
            <summary className="hint">Reference components</summary>
            <div className="comps">
              {result.comps.map((c, i) => (
                <img key={i} src={c} alt={`component ${i + 1}`} />
              ))}
            </div>
          </details>
          <div className="row">
            <button onClick={() => setResult(null)}>New puzzle</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Cayo Perico (slice alignment) ---------------- */

const CAYO_ROWS = 8;

/** Sub-regions of the cayo capture frame (fractions of the guide box),
 * measured from real gameplay photos. */
const CAYO_BOX_ROWS = { x: 0.05, y: 0.28, w: 0.37, h: 0.63 };
const CAYO_BOX_PRINT = { x: 0.5, y: 0.28, w: 0.47, h: 0.68 };
const CAYO_FRAME_ASPECT = 0.75;

interface CayoRow {
  current: number; // band index currently shown
  score: number;
  img: string;
}

function Cayo() {
  const [bands, setBands] = useState<string[]>([]);
  const [rows, setRows] = useState<CayoRow[] | null>(null);

  const onShot = (frame: HTMLCanvasElement) => {
    // anchor on the detected game window (screen size / framing independent);
    // guide boxes are only the fallback when detection fails
    const regions = detectCayoRegions(frame) ?? {
      rows: CAYO_BOX_ROWS,
      print: CAYO_BOX_PRINT,
    };
    // isolate the print as the largest bright blob so its 8 bands line up
    // with the true slices (immune to dot-grid panel backgrounds)
    const printC = largestBlobCrop(
      cropRegion(
        frame,
        regions.print.x,
        regions.print.y,
        regions.print.w,
        regions.print.h,
        512,
        640,
      ),
    );
    const b = sliceRows(printC, CAYO_ROWS, 0.95, 0.9);
    const bandVecs = b.map(gridVariants);
    setBands(b.map((c) => canvasToDataURL(c, 200)));
    const rowsC = cropRegion(
      frame,
      regions.rows.x,
      regions.rows.y,
      regions.rows.w,
      regions.rows.h,
      512,
      1024,
    );
    // detect the 8 bordered row slots (tolerates loose vertical alignment);
    // fall back to uniform slicing if detection fails
    const bandsY = detectHBands(rowsC, CAYO_ROWS);
    const cells = bandsY
      ? bandsY.map(([y0, y1]) =>
          cropRegion(rowsC, 0.1, y0 + 0.15 * (y1 - y0), 0.8, 0.7 * (y1 - y0), 256, 64),
        )
      : sliceRows(rowsC, CAYO_ROWS, 0.8, 0.7);
    setRows(
      cells.map((c) => {
        const v = toGrid(c);
        let current = 0;
        let score = -Infinity;
        bandVecs.forEach((variants, i) => {
          const s = Math.max(...variants.map((bv) => shiftSim(v, bv)));
          if (s > score) {
            score = s;
            current = i;
          }
        });
        return { current, score, img: canvasToDataURL(c, 200) };
      }),
    );
  };

  const reset = () => {
    setBands([]);
    setRows(null);
  };

  return (
    <div className="solve">
      {!rows && (
        <Camera
          guideAspect={CAYO_FRAME_ASPECT}
          label="Fit the puzzle — 8 rows & big print in their boxes"
          subBoxes={[
            { ...CAYO_BOX_ROWS, label: "8 rows" },
            { ...CAYO_BOX_PRINT, label: "big print" },
          ]}
          onCapture={onShot}
        />
      )}

      {rows && (
        <div className="result">
          <p className="ok">Moves per row (top to bottom):</p>
          <div className="cayo-rows">
            {rows.map((r, n) => {
              const right = (n - r.current + CAYO_ROWS) % CAYO_ROWS;
              const move =
                right === 0
                  ? "✓ correct"
                  : right <= CAYO_ROWS / 2
                    ? `${right} → right`
                    : `${CAYO_ROWS - right} ← left`;
              return (
                <div key={n} className="cayo-row">
                  <span className="cayo-n">{n + 1}</span>
                  <img src={r.img} alt={`row ${n + 1}`} />
                  <span
                    className={
                      right === 0 ? "ok" : r.score < 0.3 ? "warn" : undefined
                    }
                  >
                    {move}
                    {r.score < 0.3 ? " ?" : ""}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="hint">
            Directions assume →/right steps the slice forward in the sequence.
            If a row moves the wrong way, go the opposite direction. "?" = low
            confidence — retake if results look off.
          </p>
          <div className="row">
            <button onClick={reset}>Retake</button>
          </div>
          <details>
            <summary className="hint">Target bands (reference)</summary>
            <div className="cayo-rows">
              {bands.map((b, i) => (
                <div key={i} className="cayo-row">
                  <span className="cayo-n">{i + 1}</span>
                  <img src={b} alt={`band ${i + 1}`} />
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

/* ---------------- Math (circuit target-sum) ---------------- */

const PERMS: [number, number, number][] = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

/** Sub-regions of the math capture frame (fractions of the guide box). */
const MATH_BOX_TARGET = { x: 0.35, y: 0.02, w: 0.27, h: 0.15 };
const MATH_BOX_NUMS = { x: 0.01, y: 0.18, w: 0.15, h: 0.7 };
const MATH_FRAME_ASPECT = 0.9;

/**
 * The circuit hack: three numbers each link to one modifier (×1, ×2, ×10 —
 * each used once); the weighted sum must equal the target. Only 6 possible
 * assignments, so enumerate them. Values come from a photo (7-seg OCR) and
 * stay editable for corrections.
 */
function MathSolve() {
  const [scanned, setScanned] = useState(false);
  const [target, setTarget] = useState("");
  const [nums, setNums] = useState(["", "", ""]);
  const [mults, setMults] = useState(["1", "2", "10"]);

  const onShot = (frame: HTMLCanvasElement) => {
    const t = readSlottedDisplay(
      cropRegion(
        frame,
        MATH_BOX_TARGET.x,
        MATH_BOX_TARGET.y,
        MATH_BOX_TARGET.w,
        MATH_BOX_TARGET.h,
        480,
        200,
      ),
      3,
    );
    const numsC = cropRegion(
      frame,
      MATH_BOX_NUMS.x,
      MATH_BOX_NUMS.y,
      MATH_BOX_NUMS.w,
      MATH_BOX_NUMS.h,
      240,
      960,
    );
    const ns = [0, 1, 2].map((i) =>
      readBoxedDigit(cropRegion(numsC, 0, i / 3, 1, 1 / 3, 240, 320)),
    );
    setTarget(t === null ? "" : String(t));
    setNums(ns.map((n) => (n === null ? "" : String(n))));
    setScanned(true);
  };

  if (!scanned) {
    return (
      <div className="solve">
        <Camera
          guideAspect={MATH_FRAME_ASPECT}
          label="Fit the puzzle — target & numbers in their boxes"
          subBoxes={[
            { ...MATH_BOX_TARGET, label: "target" },
            { ...MATH_BOX_NUMS, label: "3 numbers" },
          ]}
          onCapture={onShot}
        />
      </div>
    );
  }

  const t = parseInt(target, 10);
  const n = nums.map((v) => parseInt(v, 10));
  const m = mults.map((v) => parseInt(v, 10));
  const ready = !isNaN(t) && n.every((v) => !isNaN(v)) && m.every((v) => !isNaN(v));

  const solutions = ready
    ? PERMS.filter((p) => n[0] * m[p[0]] + n[1] * m[p[1]] + n[2] * m[p[2]] === t)
    : [];

  const setNum = (i: number, v: string) =>
    setNums((a) => a.map((x, j) => (j === i ? v : x)));
  const setMult = (i: number, v: string) =>
    setMults((a) => a.map((x, j) => (j === i ? v : x)));

  return (
    <div className="solve">
      <p className="hint">
        Scanned values below — fix any the camera misread. Each number links
        to one modifier.
      </p>
      <div className="row">
        <button className="alt" onClick={() => setScanned(false)}>
          Rescan
        </button>
      </div>
      <div className="math-form">
        <label>
          Target
          <input
            type="number"
            inputMode="numeric"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="500"
          />
        </label>
        <div className="math-row">
          {nums.map((v, i) => (
            <label key={i}>
              #{i + 1}
              <input
                type="number"
                inputMode="numeric"
                value={v}
                onChange={(e) => setNum(i, e.target.value)}
              />
            </label>
          ))}
        </div>
        <details>
          <summary className="hint">Modifiers (×{mults.join(", ×")})</summary>
          <div className="math-row">
            {mults.map((v, i) => (
              <label key={i}>
                ×
                <input
                  type="number"
                  inputMode="numeric"
                  value={v}
                  onChange={(e) => setMult(i, e.target.value)}
                />
              </label>
            ))}
          </div>
        </details>
      </div>

      {ready && solutions.length === 0 && (
        <p className="warn">
          No assignment hits {t}. Double-check the numbers (or the modifiers).
        </p>
      )}
      {solutions.map((p, si) => (
        <div className="result math-solution" key={si}>
          <p className="ok">{solutions.length > 1 ? `Option ${si + 1}` : "Link:"}</p>
          {p.map((mi, ni) => (
            <p key={ni} className="math-link">
              <b>{n[ni]}</b> → <b>×{m[mi]}</b> modifier
              {"  "}({n[ni]} × {m[mi]} = {n[ni] * m[mi]})
            </p>
          ))}
          <p className="hint">
            {p.map((mi, ni) => `${n[ni]}×${m[mi]}`).join(" + ")} = {t}
          </p>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Host (find the IP in the number wall) ---------------- */

const HOST_FRAME_ASPECT = 0.63;
const HOST_BOX_IP = { x: 0.33, y: 0.11, w: 0.29, h: 0.1 };
const HOST_BOX_GRID = { x: 0.07, y: 0.31, w: 0.78, h: 0.62 };

interface HostCell {
  row: number;
  col: number;
  img: string;
  hit: number; // -1 = no, otherwise sequence position 0..3
}

function Host() {
  const [rows, setRows] = useState<HostCell[][] | null>(null);
  const [ipImgs, setIpImgs] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  const onShot = (frame: HTMLCanvasElement) => {
    setFailed(false);
    const ipBB = contentBBoxCrop(
      cropRegion(
        frame,
        HOST_BOX_IP.x,
        HOST_BOX_IP.y,
        HOST_BOX_IP.w,
        HOST_BOX_IP.h,
        640,
        128,
      ),
      0.02,
    );
    const ipSpans = splitIpPairs(textBands(ipBB, "x", 0.004, 0.012), 4);
    if (!ipSpans) {
      setFailed(true);
      return;
    }
    const ipCanvases = ipSpans.map(([x0, x1]) =>
      cropRegion(ipBB, x0, 0, x1 - x0, 1, 96, 64),
    );
    const ipVecs = ipCanvases.map(pairVec);
    setIpImgs(ipCanvases.map((c) => canvasToDataURL(c, 72)));
    const gridC = cropRegion(
      frame,
      HOST_BOX_GRID.x,
      HOST_BOX_GRID.y,
      HOST_BOX_GRID.w,
      HOST_BOX_GRID.h,
      1024,
      512,
    );
    const rowBands = textBands(gridC, "y", 0.01, 0.02);
    const flat: { cell: HostCell; vec: Float32Array }[] = [];
    const grid: HostCell[][] = [];
    rowBands.forEach(([y0, y1], r) => {
      const rowC = cropRegion(gridC, 0, y0, 1, y1 - y0, 1024, 64);
      const groups = groupPairBands(textBands(rowC, "x", 0.003, 0.008));
      const rowCells: HostCell[] = [];
      groups.forEach(([x0, x1], c) => {
        const cellC = cropRegion(rowC, x0, 0, x1 - x0, 1, 96, 64);
        const cell: HostCell = {
          row: r + 1,
          col: c + 1,
          img: canvasToDataURL(cellC, 64),
          hit: -1,
        };
        rowCells.push(cell);
        flat.push({ cell, vec: pairVec(cellC) });
      });
      grid.push(rowCells);
    });
    if (flat.length < 8) {
      setFailed(true);
      return;
    }
    let best = { score: -Infinity, i: 0 };
    for (let i = 0; i + 3 < flat.length; i++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += pairSim(flat[i + k].vec, ipVecs[k]);
      if (s > best.score) best = { score: s, i };
    }
    for (let k = 0; k < 4; k++) flat[best.i + k].cell.hit = k;
    setRows(grid);
  };

  const reset = () => {
    setRows(null);
    setIpImgs([]);
    setFailed(false);
  };

  return (
    <div className="solve">
      {!rows && (
        <>
          {failed && (
            <p className="warn">Couldn't read that — try again, closer.</p>
          )}
          <Camera
            guideAspect={HOST_FRAME_ASPECT}
            label="Fit the blue window — IP & number wall in their boxes"
            subBoxes={[
              { ...HOST_BOX_IP, label: "target IP" },
              { ...HOST_BOX_GRID, label: "number wall" },
            ]}
            onCapture={onShot}
          />
        </>
      )}

      {rows && (
        <div className="result">
          <p className="ok">Sequence found — press these in order:</p>
          <div className="host-seq">
            {rows.flat().filter((c) => c.hit >= 0).sort((a, b) => a.hit - b.hit)
              .map((c) => (
                <span key={c.hit}>
                  {c.hit + 1}. row {c.row}, #{c.col}
                </span>
              ))}
          </div>
          <div className="host-grid">
            {rows.map((row, ri) => (
              <div key={ri} className="host-row">
                {row.map((c, ci) => (
                  <img
                    key={ci}
                    src={c.img}
                    className={c.hit >= 0 ? "hit" : ""}
                    alt={`r${c.row}c${c.col}`}
                  />
                ))}
              </div>
            ))}
          </div>
          <details>
            <summary className="hint">Target pairs (as read)</summary>
            <div className="host-seq">
              {ipImgs.map((s, i) => (
                <img key={i} src={s} alt={`pair ${i + 1}`} />
              ))}
            </div>
          </details>
          <div className="row">
            <button onClick={reset}>Retake</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- App ---------------- */

export default function App() {
  const [tab, setTab] = useState<Tab>("solve");

  return (
    <div className="app">
      <header>
        <h1>FINGERPRINT SOLVER</h1>
        <nav>
          <button
            className={tab === "solve" ? "active" : ""}
            onClick={() => setTab("solve")}
          >
            Casino
          </button>
          <button
            className={tab === "cayo" ? "active" : ""}
            onClick={() => setTab("cayo")}
          >
            Cayo
          </button>
          <button
            className={tab === "math" ? "active" : ""}
            onClick={() => setTab("math")}
          >
            Math
          </button>
          <button
            className={tab === "host" ? "active" : ""}
            onClick={() => setTab("host")}
          >
            Host
          </button>
        </nav>
      </header>
      {tab === "solve" && <Solve />}
      {tab === "cayo" && <Cayo />}
      {tab === "math" && <MathSolve />}
      {tab === "host" && <Host />}
    </div>
  );
}
