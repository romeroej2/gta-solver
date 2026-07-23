import { useCallback, useEffect, useRef, useState } from "react";
import {
  canvasToDataURL,
  cropFromVideo,
  cropRegion,
  detectCayoRegions,
  detectHBands,
  largestBlobCrop,
  gridVariants,
  printSim,
  shiftSim,
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

type Tab = "solve" | "cayo";

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

function Solve({ refs }: { refs: LoadedRef[] }) {
  const [result, setResult] = useState<SolveResult | null>(null);

  if (refs.length === 0) {
    return (
      <div className="empty">
        <p>Loading answer sheet…</p>
      </div>
    );
  }

  const onShot = (frame: HTMLCanvasElement) => {
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

/* ---------------- App ---------------- */

export default function App() {
  const [tab, setTab] = useState<Tab>("solve");
  const [refs, setRefs] = useState<LoadedRef[]>([]);

  useEffect(() => {
    loadRefs().then(setRefs);
  }, []);

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
        </nav>
      </header>
      {tab === "solve" ? <Solve refs={refs} /> : <Cayo />}
    </div>
  );
}
