export type TrajectoryStep = {
  name: string;
  kind: "llm" | "tool" | "step";
  input?: unknown;
  output?: unknown;
  latencyMs?: number;
};

export type TaskOutput = {
  output: string;
  trajectory?: TrajectoryStep[];
  /** Task wall time. The runner fills it in when the task does not. */
  latencyMs?: number;
};

export type TaskFn<I = string> = (input: I, signal?: AbortSignal) => Promise<TaskOutput>;

export type EvalCase<I = string, E = string> = {
  id: string;
  input: I;
  expected?: E;
  metadata?: Record<string, unknown>;
};

/**
 * What a scorer measured. Scorers never decide pass/fail; the eval author
 * does, through `EvalThresholds.scorers`.
 */
export type Result =
  | { kind: "score"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "category"; value: string; scale?: readonly string[] };

export type ScorerResult = {
  result: Result;
  label?: string;
  explanation?: string;
  /** Absent when the source reports none (e.g. noul); never read it unconditionally. */
  confidence?: number;
  metadata?: Record<string, unknown>;
};

export type Scorer<I = string, E = string> = (args: {
  evalCase: EvalCase<I, E>;
  result: TaskOutput;
}) => Promise<ScorerResult> | ScorerResult;

/** Pass rule for one scorer. The variant must match the scorer's `Result.kind`. */
export type ScorerThreshold =
  | { min: number }
  | { expect: boolean }
  | { allow: readonly string[] }
  | { atLeast: string };

/** Runner output per scorer: the scorer's result plus the author's verdict on it. */
export type ScorerVerdict = ScorerResult & {
  pass: boolean;
  /** `Result` normalized to 0..1 for aggregation. */
  score: number;
};

export type CaseReport = {
  id: string;
  pass: boolean;
  score: number;
  scorers: Record<string, ScorerVerdict>;
  /** Whole case: every attempt's task plus scoring. Not the task latency (see TaskOutput.latencyMs). */
  latencyMs: number;
  /** Set when the task threw or timed out. Scorer failures live in `scorers`. */
  error?: string;
};

export type EvalReport = {
  eval: string;
  /** ISO time the run started. */
  startedAt: string;
  /** Caller-supplied run context from `EvalSpec.metadata`, e.g. the model id. */
  metadata?: Record<string, unknown>;
  total: number;
  passed: number;
  passRate: number;
  avgScore: number;
  thresholdsMet: boolean;
  cases: CaseReport[];
};
