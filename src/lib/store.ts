// Built-in answer sheet (see defaults.ts); feature vectors computed on load.

import { defaultRefs } from "./defaults";
import { dataURLToVec, type Vec } from "./image";

export interface PrintRef {
  slot: number; // 1..4
  target: string;
  comps: string[]; // 4 image URLs
}

export interface LoadedRef extends PrintRef {
  targetVec: Vec;
  compVecs: Vec[];
}

export async function loadRefs(): Promise<LoadedRef[]> {
  return Promise.all(
    defaultRefs.map(async (r) => ({
      ...r,
      targetVec: await dataURLToVec(r.target),
      compVecs: await Promise.all(r.comps.map(dataURLToVec)),
    })),
  );
}
