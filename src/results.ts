import type { Result, ScorerResult, ScorerThreshold, ScorerVerdict } from "./types.js";

export function scoreResult(value: number): Result {
  return { kind: "score", value };
}

export function booleanResult(value: boolean): Result {
  return { kind: "boolean", value };
}

export function categoryResult(value: string, scale?: readonly string[]): Result {
  return scale === undefined ? { kind: "category", value } : { kind: "category", value, scale };
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * 0..1 for aggregation. A category with no scale has no numeric meaning,
 * so it maps to 1 when it passes and 0 otherwise.
 */
export function normalize(result: Result, pass: boolean): number {
  switch (result.kind) {
    case "score":
      return clamp01(result.value);
    case "boolean":
      return result.value ? 1 : 0;
    case "category": {
      const scale = result.scale;
      if (scale === undefined) return pass ? 1 : 0;
      if (scale.length <= 1) return 1;
      const index = scale.indexOf(result.value);
      return index < 0 ? 0 : index / (scale.length - 1);
    }
  }
}

export function describe(result: Result): string {
  switch (result.kind) {
    case "score":
      return result.value.toFixed(2);
    case "boolean":
      return result.value ? "true" : "false";
    case "category":
      return result.value;
  }
}

type Outcome = { pass: boolean; reason?: string };

/**
 * Defaults when the author sets no threshold: a score must be 1, a boolean
 * must be true, a category must be the top of its scale. A category with
 * no scale and no threshold cannot be judged and fails closed.
 */
export function meets(result: Result, threshold: ScorerThreshold | undefined): Outcome {
  if (result.kind === "score") {
    if (threshold === undefined) return { pass: result.value >= 1 };
    if ("min" in threshold) return { pass: result.value >= threshold.min };
    return mismatch(result, threshold);
  }
  if (result.kind === "boolean") {
    if (threshold === undefined) return { pass: result.value };
    if ("expect" in threshold) return { pass: result.value === threshold.expect };
    return mismatch(result, threshold);
  }
  if (threshold === undefined) {
    const scale = result.scale;
    if (scale === undefined) {
      return { pass: false, reason: "category result has no scale and no threshold" };
    }
    return { pass: result.value === scale[scale.length - 1] };
  }
  if ("allow" in threshold) return { pass: threshold.allow.includes(result.value) };
  if ("atLeast" in threshold) {
    const scale = result.scale;
    if (scale === undefined) return { pass: false, reason: "atLeast needs a category scale" };
    const floor = scale.indexOf(threshold.atLeast);
    if (floor < 0) return { pass: false, reason: `"${threshold.atLeast}" is not on the scale` };
    return { pass: scale.indexOf(result.value) >= floor };
  }
  return mismatch(result, threshold);
}

function mismatch(result: Result, threshold: ScorerThreshold): Outcome {
  return {
    pass: false,
    reason: `threshold ${JSON.stringify(threshold)} does not apply to a ${result.kind} result`,
  };
}

export function toVerdict(
  result: ScorerResult,
  threshold: ScorerThreshold | undefined,
): ScorerVerdict {
  const outcome = meets(result.result, threshold);
  const verdict: ScorerVerdict = {
    ...result,
    pass: outcome.pass,
    score: normalize(result.result, outcome.pass),
  };
  if (outcome.reason !== undefined) {
    verdict.explanation =
      result.explanation === undefined
        ? outcome.reason
        : `${outcome.reason}; ${result.explanation}`;
  }
  return verdict;
}

/** Scorer output is untrusted. Anything malformed fails closed. */
export function validateScorerResult(name: string, raw: unknown): ScorerResult | string {
  const r = raw as Partial<ScorerResult> | null | undefined;
  const result = r?.result as Partial<Result> | undefined;
  if (r === null || typeof r !== "object" || result === null || typeof result !== "object") {
    return `scorer "${name}" returned an invalid result: ${JSON.stringify(raw)}`;
  }
  const ok =
    (result.kind === "score" &&
      typeof result.value === "number" &&
      Number.isFinite(result.value) &&
      result.value >= 0 &&
      result.value <= 1) ||
    (result.kind === "boolean" && typeof result.value === "boolean") ||
    (result.kind === "category" &&
      typeof result.value === "string" &&
      (result.scale === undefined ||
        (Array.isArray(result.scale) && result.scale.every((s) => typeof s === "string"))));
  if (!ok) return `scorer "${name}" returned an invalid result: ${JSON.stringify(raw)}`;
  if (r.confidence !== undefined && !Number.isFinite(r.confidence)) {
    return `scorer "${name}" returned a non-finite confidence`;
  }
  return r as ScorerResult;
}
