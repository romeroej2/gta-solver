// Built-in answer sheet, sliced from the cheat-sheet image (scripts/crop.ps1).
// User calibration (localStorage) overrides these per slot.

import type { PrintRef } from "./store";

const files = import.meta.glob("../assets/refs/*.jpg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function url(name: string): string {
  const hit = Object.entries(files).find(([k]) => k.endsWith(`/${name}.jpg`));
  if (!hit) throw new Error(`missing ref asset: ${name}`);
  return hit[1];
}

export const defaultRefs: PrintRef[] = [1, 2, 3, 4].map((slot) => ({
  slot,
  target: url(`print${slot}-target`),
  comps: [1, 2, 3, 4].map((c) => url(`print${slot}-comp${c}`)),
}));
