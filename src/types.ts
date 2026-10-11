export type Step = {
  name: string;
  kind: "llm" | "tool" | "step";
  input?: unknown;
  output?: unknown;
  ms?: number;
};

export type Case<I = unknown, E = unknown> = {
  /** Keys the case in reports and baselines. Defaults to the input. */
  name?: string;
  input: I;
  expect?: E;
};

/** One run of one case, as every check sees it. */
export type Run<I = unknown, O = unknown, E = unknown> = {
  input: I;
  output: O;
  expect?: E;
  steps: Step[];
  ms: number;
};

/** A check's answer for one case. `value` is 0..1. */
export type Outcome = {
  pass: boolean;
  value: number;
  explanation?: string;
  /** What a Jev check picked. */
  label?: string;
};

/** A number must be 0..1 and passes only at 1. */
export type CheckValue = boolean | number | Outcome;

export type CheckFn<I = unknown, O = unknown, E = unknown> = (
  run: Run<I, O, E>,
) => CheckValue | Promise<CheckValue>;

export type CaseResult<I = unknown, O = unknown, E = unknown> = {
  name: string;
  input: I;
  expect?: E;
  output?: O;
  steps: Step[];
  /** Whole case: every attempt's run plus checks. */
  ms: number;
  pass: boolean;
  /** Set when the run threw or timed out; every check then fails. */
  error?: string;
  checks: Record<string, Outcome>;
};

/** A case × check whose pass flipped against the baseline. */
export type Change = { case: string; check: string; change: "fixed" | "broke" };

export type Report<I = unknown, O = unknown, E = unknown> = {
  name: string;
  about?: Record<string, unknown>;
  /** Pass rate met and nothing broke against the baseline. */
  ok: boolean;
  total: number;
  passed: number;
  passRate: number;
  checks: Record<string, { passed: number; total: number }>;
  cases: CaseResult<I, O, E>[];
  /** Present when a baseline existed before this run. */
  changes?: Change[];
  markdown(): string;
  /** Writes the run in baseline form. */
  save(path: string): Promise<void>;
};
