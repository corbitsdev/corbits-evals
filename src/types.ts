export type Step = {
  name: string;
  kind: "llm" | "tool" | "step";
  input?: unknown;
  output?: unknown;
  ms?: number;
};

export type Case<I = unknown, E = unknown> = {
  /** Keys the case in reports and compared runs. Defaults to the input. */
  name?: string;
  input: I;
  expect?: E;
  /** Checks that must pass on this case, whatever `allow` says. */
  must?: readonly string[];
  /** Checks this case is not run or counted for. */
  skip?: readonly string[];
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

/** A case × check whose pass flipped against the compared run. */
export type Change = { case: string; check: string; change: "fixed" | "broke" };

/** One check over every case it counted for, against its allowance. */
export type CheckResult = {
  passed: number;
  /** Cases that do not skip the check. */
  counted: number;
  missed: number;
  allow: { miss: number; drop: number };
  /** Cases that passed in the compared run and fail now. Set when comparing. */
  drop?: number;
  /** Cases that `must` pass the check and failed it. */
  mustFailed: string[];
  ok: boolean;
};

export type Report<I = unknown, O = unknown, E = unknown> = {
  name: string;
  about?: Record<string, unknown>;
  /** Every check within its allowance. */
  ok: boolean;
  total: number;
  passed: number;
  checks: Record<string, CheckResult>;
  cases: CaseResult<I, O, E>[];
  /** Present when comparing. */
  changes?: Change[];
  /** Cases only in this run. Present when comparing. */
  added?: string[];
  /** Cases only in the compared run. Present when comparing. */
  removed?: string[];
  markdown(): string;
};
