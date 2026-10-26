import type { CheckFn, Outcome, Run } from "./types.js";

/** Check output is untrusted. Anything malformed fails closed. */
export function toOutcome(name: string, raw: unknown): Outcome {
  if (typeof raw === "boolean") return { pass: raw, value: raw ? 1 : 0 };
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1) {
    return { pass: raw === 1, value: raw };
  }
  const o = raw as Partial<Outcome> | null;
  if (
    typeof o === "object" &&
    o !== null &&
    typeof o.pass === "boolean" &&
    typeof o.value === "number" &&
    Number.isFinite(o.value) &&
    o.value >= 0 &&
    o.value <= 1 &&
    (o.explanation === undefined || typeof o.explanation === "string") &&
    (o.label === undefined || typeof o.label === "string")
  ) {
    return o as Outcome;
  }
  return {
    pass: false,
    value: 0,
    explanation: `check "${name}" returned an invalid value: ${JSON.stringify(raw)}`,
  };
}

/** Case-insensitive substring. Value is 1 or 0. Strings only; no coercion. */
export function includes(): CheckFn<unknown, unknown, unknown> {
  return ({ output, expectedOutput }) => {
    if (typeof output !== "string" || typeof expectedOutput !== "string") {
      return {
        pass: false,
        value: 0,
        explanation: "includes needs string output and expectedOutput",
      };
    }
    const needle = collapsed(expectedOutput);
    if (needle.length === 0) {
      return { pass: false, value: 0, explanation: "includes needle is empty" };
    }
    const pass = collapsed(output).includes(needle);
    return pass
      ? { pass: true, value: 1 }
      : { pass: false, value: 0, explanation: "output does not include the expected text" };
  };
}

/** NFKC, trim, collapse internal whitespace, then lowercase. */
function collapsed(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Output deep-equals expectedOutput, or one field of each (a key or an accessor). */
export function matches<T = unknown>(
  field?: string | ((value: T) => unknown),
): CheckFn<unknown, T, T> {
  const get = (value: T): unknown => {
    if (field === undefined) return value;
    if (typeof field === "function") return field(value);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[field]
      : undefined;
  };
  return ({ output, expectedOutput }) => {
    if (expectedOutput === undefined)
      return { pass: false, value: 0, explanation: "case has no expectedOutput" };
    const got = get(output);
    const want = get(expectedOutput);
    if (Bun.deepEquals(got, want)) return true;
    return {
      pass: false,
      value: 0,
      explanation: `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
    };
  };
}

/** The Standard Schema interface (arktype, zod, valibot, ...). */
export type StandardSchema = {
  readonly "~standard": {
    validate(
      value: unknown,
    ):
      | { value: unknown; issues?: undefined }
      | { issues: readonly { message: string }[] }
      | Promise<
          { value: unknown; issues?: undefined } | { issues: readonly { message: string }[] }
        >;
  };
};

export function fitsSchema(schema: StandardSchema): CheckFn {
  return async ({ output }) => {
    const result = await schema["~standard"].validate(output);
    if (result.issues === undefined) return true;
    return { pass: false, value: 0, explanation: result.issues.map((i) => i.message).join("; ") };
  };
}

/** Fixed words, or words picked per case (e.g. from `expectedOutput`). */
export type Words<I = unknown, O = unknown, E = unknown> =
  | readonly string[]
  | ((run: Run<I, O, E>) => readonly string[]);

/** Pass at this fraction or above. Defaults to 1. */
export type AtLeast = { atLeast?: number };

function threshold(helper: string, options: AtLeast): number {
  const { atLeast = 1 } = options;
  if (!(Number.isFinite(atLeast) && atLeast > 0 && atLeast <= 1)) {
    throw new Error(`${helper}: atLeast must be in (0, 1]`);
  }
  return atLeast;
}

function requireWords<I, O, E>(words: Words<I, O, E>, helper: string): void {
  if (typeof words !== "function" && words.length === 0) throw new Error(`${helper} needs words`);
}

function text(value: unknown): string {
  return (typeof value === "string" ? value : (JSON.stringify(value) ?? ""))
    .normalize("NFKC")
    .toLowerCase();
}

function found<I, O, E>(
  words: Words<I, O, E>,
  run: Run<I, O, E>,
): { hit: string[]; miss: string[] } {
  const list = typeof words === "function" ? words(run) : words;
  if (list.length === 0) throw new Error("no words to look for");
  const haystack = text(run.output);
  const hit = list.filter((w) => haystack.includes(text(w)));
  return { hit, miss: list.filter((w) => !hit.includes(w)) };
}

/** Case-insensitive. Value is the fraction of words found. */
export function mentions<I = unknown, O = unknown, E = unknown>(
  words: Words<I, O, E>,
  options: AtLeast = {},
): CheckFn<I, O, E> {
  requireWords(words, "mentions");
  const atLeast = threshold("mentions", options);
  return (run) => {
    const { hit, miss } = found(words, run);
    const value = hit.length / (hit.length + miss.length);
    const outcome: Outcome = { pass: value >= atLeast, value };
    if (miss.length > 0) outcome.explanation = `missing: ${miss.join(", ")}`;
    return outcome;
  };
}

/** Case-insensitive. Passes only when no word is found. */
export function avoids<I = unknown, O = unknown, E = unknown>(
  words: Words<I, O, E>,
): CheckFn<I, O, E> {
  requireWords(words, "avoids");
  return (run) => {
    const { hit, miss } = found(words, run);
    if (hit.length === 0) return true;
    return {
      pass: false,
      value: miss.length / (hit.length + miss.length),
      explanation: `found: ${hit.join(", ")}`,
    };
  };
}

function stepNames(run: Run): string[] {
  return run.steps.filter((s) => s.kind === "tool" || s.kind === "step").map((s) => s.name);
}

/** F1 of `tool` and `step` names against `names`, order ignored. */
export function ranSteps(names: readonly string[], options: AtLeast = {}): CheckFn {
  const atLeast = threshold("ranSteps", options);
  const expected = [...names].sort();
  return (run) => {
    const actual = stepNames(run).sort();
    const explanation = `expected [${expected.join(", ")}], got [${actual.join(", ")}]`;
    if (expected.length === 0) {
      if (run.steps.length === 0) {
        return {
          pass: false,
          value: 0,
          explanation: "an empty step list is not an observed empty tool path",
        };
      }
      return { pass: actual.length === 0, value: actual.length === 0 ? 1 : 0, explanation };
    }
    const counts = new Map<string, number>();
    for (const name of actual) counts.set(name, (counts.get(name) ?? 0) + 1);
    let overlap = 0;
    for (const name of expected) {
      const left = counts.get(name) ?? 0;
      if (left > 0) {
        overlap += 1;
        counts.set(name, left - 1);
      }
    }
    const precision = actual.length === 0 ? 0 : overlap / actual.length;
    const recall = overlap / expected.length;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { pass: f1 >= atLeast, value: f1, explanation };
  };
}

export function stepsAtMost(n: number): CheckFn {
  if (!Number.isInteger(n) || n < 0) throw new Error("stepsAtMost needs a whole number >= 0");
  return (run) => {
    const count = run.steps.length;
    return {
      pass: count <= n,
      value: count <= n ? 1 : 0,
      explanation: `${count} steps, at most ${n}`,
    };
  };
}

export type Budget = { ms?: number };

export function under(budget: Budget): CheckFn {
  const { ms } = budget;
  if (ms === undefined) throw new Error("under needs a budget, e.g. { ms: 5000 }");
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("under: ms must be a finite number > 0");
  return (run) => ({
    pass: run.ms <= ms,
    value: run.ms <= ms ? 1 : 0,
    explanation: `${run.ms}ms vs budget ${ms}ms`,
  });
}
