import type { StructureTemplateLeg } from "../types/domain";

export interface DecomposedUnit {
  weight: number; // signed ratio for this instance of the base structure
  offset: number; // months forward from the structure's own anchor
}

/** Flatten signed offset/ratio pairs into a dense array starting at offset 0 (summing duplicates). */
function toDenseArray(legs: StructureTemplateLeg[]): number[] {
  const minOffset = Math.min(...legs.map((l) => l.month_offset));
  const maxOffset = Math.max(...legs.map((l) => l.month_offset));
  const arr = new Array(maxOffset - minOffset + 1).fill(0);
  for (const l of legs) arr[l.month_offset - minOffset] += l.ratio;
  return arr;
}

/**
 * Deconvolves a target outright ratio pattern (a structure template's
 * `legs`, e.g. Double Fly = +1/-3/+3/-1) into a sequence of weighted,
 * shifted copies of a base structure's own pattern (e.g. Fly = +1/-2/+1),
 * such that the weighted sum of those shifted copies reproduces the target
 * exactly — this is how "construct a Double Fly from 2 Flies" or "from 3
 * Spreads" is actually computed (spec V5). Works via synthetic division:
 * at each position, solve for the weight that zeroes the target's leading
 * remaining coefficient, then subtract that shifted, scaled copy of the
 * base pattern and move on.
 *
 * Throws if the base structure's pattern is wider than the target's (too
 * few months to fit even one copy), or if the target can't be expressed
 * exactly as shifted copies of the base pattern (leftover remainder).
 */
export function deconvolve(target: StructureTemplateLeg[], base: StructureTemplateLeg[], baseName: string): DecomposedUnit[] {
  const T = toDenseArray(target);
  const U = toDenseArray(base);
  const L = T.length;
  const M = U.length;

  if (M > L) {
    throw new Error(`"${baseName}" spans more months than this structure — can't build it that way.`);
  }
  if (U[0] === 0) {
    throw new Error(`"${baseName}"'s first leg must have a nonzero ratio to use as a base structure.`);
  }

  const K = L - M + 1;
  const remaining = [...T];
  const weights: number[] = new Array(K).fill(0);

  for (let i = 0; i < K; i++) {
    const w = remaining[i] / U[0];
    weights[i] = w;
    for (let j = 0; j < M; j++) {
      remaining[i + j] -= w * U[j];
    }
  }

  const leftover = remaining.some((v) => Math.abs(v) > 1e-6);
  if (leftover) {
    throw new Error(`Can't construct this structure exactly from "${baseName}" — the pattern doesn't divide evenly.`);
  }

  return weights
    .map((weight, offset) => ({ weight: Math.round(weight * 1e6) / 1e6, offset }))
    .filter((w) => w.weight !== 0);
}
