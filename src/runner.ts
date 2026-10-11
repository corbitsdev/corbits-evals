import { score, toVerdict, validateScorerResult } from "./results.js";
import { withTimeout } from "./timeout.js";
import type {
  CaseReport,
  EvalCase,
  EvalReport,
  Scorer,
  ScorerThreshold,
  ScorerVerdict,
  TaskFn,
  TaskOutput,
} from "./types.js";

export type EvalThresholds = {
  /** Per-scorer pass rules, keyed by scorer name. Unlisted scorers use the kind's default. */
  scorers?: Record<string, ScorerThreshold>;
  passRate?: number;
  avgScore?: number;
};

export type EvalSpec<I = string, E = string> = {
  name: string;
  dataset: EvalCase<I, E>[];
  task: TaskFn<I>;
  scorers: Record<string, Scorer<I, E>>;
  repeats?: number;
  /** Bounds the task per attempt. On expiry the task is aborted via its signal and the case fails. */
  timeoutMs?: number;
  /** Bounds each scorer per attempt. Defaults to `timeoutMs`. */
  scorerTimeoutMs?: number;
  concurrency?: number;
  thresholds?: EvalThresholds;
  /** Carried onto the report, e.g. the model id, so stored runs say what they measured. */
  metadata?: Record<string, unknown>;
};

type Limits = Pick<EvalSpec, "name" | "repeats" | "concurrency" | "timeoutMs" | "scorerTimeoutMs">;

function positiveInt(spec: Limits, key: "repeats" | "concurrency"): number {
  const raw = spec[key];
  if (raw === undefined) return key === "repeats" ? 1 : 4;
  if (!Number.isFinite(raw) || raw < 1) {
    throw new Error(`eval "${spec.name}": ${key} must be a finite number >= 1`);
  }
  return Math.floor(raw);
}

function positiveMs(spec: Limits, key: "timeoutMs" | "scorerTimeoutMs"): number | undefined {
  const raw = spec[key];
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(`eval "${spec.name}": ${key} must be a finite number > 0`);
  }
  return raw;
}

function validate<I, E>(spec: EvalSpec<I, E>): void {
  if (spec.dataset.length === 0) throw new Error(`eval "${spec.name}" has an empty dataset`);
  const names = Object.keys(spec.scorers);
  if (names.length === 0) throw new Error(`eval "${spec.name}" has no scorers`);
  for (const name of Object.keys(spec.thresholds?.scorers ?? {})) {
    if (!names.includes(name)) {
      throw new Error(`eval "${spec.name}": threshold for unknown scorer "${name}"`);
    }
  }
  const ids = new Set<string>();
  for (const kase of spec.dataset) {
    if (ids.has(kase.id)) throw new Error(`eval "${spec.name}" has duplicate case id "${kase.id}"`);
    ids.add(kase.id);
  }
  positiveInt(spec, "repeats");
  positiveInt(spec, "concurrency");
  positiveMs(spec, "timeoutMs");
  positiveMs(spec, "scorerTimeoutMs");
}

export function defineEval<I = string, E = string>(spec: EvalSpec<I, E>): EvalSpec<I, E> {
  validate(spec);
  return spec;
}

export async function runEval<I = string, E = string>(spec: EvalSpec<I, E>): Promise<EvalReport> {
  validate(spec);
  const startedAt = new Date().toISOString();
  const repeats = positiveInt(spec, "repeats");
  const concurrency = positiveInt(spec, "concurrency");
  const cases = await mapPool(spec.dataset, concurrency, (kase) => runCase(spec, kase, repeats));
  const passed = cases.filter((c) => c.pass).length;
  const passRate = passed / cases.length;
  const avgScore = cases.reduce((t, c) => t + c.score, 0) / cases.length;
  const thresholdsMet =
    (spec.thresholds?.passRate === undefined || passRate >= spec.thresholds.passRate) &&
    (spec.thresholds?.avgScore === undefined || avgScore >= spec.thresholds.avgScore);
  const report: EvalReport = {
    eval: spec.name,
    startedAt,
    total: cases.length,
    passed,
    passRate,
    avgScore,
    thresholdsMet,
    cases,
  };
  if (spec.metadata !== undefined) report.metadata = { ...spec.metadata };
  return report;
}

async function runTask<I>(
  task: TaskFn<I>,
  timeoutMs: number | undefined,
  kase: Pick<EvalCase<I, unknown>, "id" | "input">,
): Promise<TaskOutput> {
  const controller = new AbortController();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    if (timeoutMs === undefined) return;
    timer = setTimeout(() => {
      const error = new Error(`case "${kase.id}" timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([task(kase.input, controller.signal), expiry]);
    return result.latencyMs === undefined ? { ...result, latencyMs: Date.now() - started } : result;
  } finally {
    clearTimeout(timer);
  }
}

function failedVerdict(explanation: string): ScorerVerdict {
  return { result: score(0), pass: false, score: 0, explanation };
}

async function runScorer<I, E>(
  name: string,
  scorer: Scorer<I, E>,
  args: Parameters<Scorer<I, E>>[0],
  threshold: ScorerThreshold | undefined,
  timeoutMs: number | undefined,
): Promise<ScorerVerdict> {
  let raw: unknown;
  try {
    const pending = Promise.resolve(scorer(args));
    raw =
      timeoutMs === undefined
        ? await pending
        : await withTimeout(pending, timeoutMs, `scorer "${name}" timed out after ${timeoutMs}ms`);
  } catch (cause) {
    return failedVerdict(
      `scorer "${name}" threw: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const checked = validateScorerResult(name, raw);
  if (typeof checked === "string") return failedVerdict(checked);
  return toVerdict(checked, threshold);
}

function compileAttempts(attempts: readonly ScorerVerdict[]): ScorerVerdict {
  const first = attempts[0];
  if (first === undefined) return failedVerdict("no attempts");
  if (attempts.length === 1) return first;
  const failed = attempts.filter((v) => !v.pass);
  // Report the attempt that decided the verdict, never a passing label on a failed scorer.
  const decider = failed[0] ?? first;
  const compiled: ScorerVerdict = {
    result: decider.result,
    pass: failed.length === 0,
    score: attempts.reduce((t, v) => t + v.score, 0) / attempts.length,
    explanation: `${attempts.length - failed.length}/${attempts.length} attempts passed${
      decider.explanation === undefined ? "" : `; ${decider.explanation}`
    }`,
    metadata: { attempts },
  };
  if (decider.label !== undefined) compiled.label = decider.label;
  const confidences = attempts.map((v) => v.confidence).filter((c): c is number => c !== undefined);
  if (confidences.length > 0) {
    compiled.confidence = confidences.reduce((t, c) => t + c, 0) / confidences.length;
  }
  return compiled;
}

async function runCase<I, E>(
  spec: EvalSpec<I, E>,
  kase: EvalCase<I, E>,
  repeats: number,
): Promise<CaseReport> {
  const started = Date.now();
  const scorerTimeoutMs = spec.scorerTimeoutMs ?? spec.timeoutMs;
  const thresholds = spec.thresholds?.scorers ?? {};
  const entries = Object.entries(spec.scorers);
  const verdicts: Record<string, ScorerVerdict[]> = {};
  for (const [name] of entries) verdicts[name] = [];
  let error: string | undefined;
  for (let attempt = 0; attempt < repeats; attempt += 1) {
    let result;
    try {
      result = await runTask(spec.task, spec.timeoutMs, kase);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      break;
    }
    const scored = await Promise.all(
      entries.map(async ([name, scorer]) => {
        const verdict = await runScorer(
          name,
          scorer,
          { kase, result },
          thresholds[name],
          scorerTimeoutMs,
        );
        return [name, verdict] as const;
      }),
    );
    for (const [name, verdict] of scored) verdicts[name]?.push(verdict);
  }
  const scorers: Record<string, ScorerVerdict> = {};
  for (const [name] of entries) scorers[name] = compileAttempts(verdicts[name] ?? []);
  const scores = Object.values(scorers).map((s) => s.score);
  // A task error zeroes the case so partial repeats never inflate avgScore.
  const caseScore = error !== undefined ? 0 : scores.reduce((t, s) => t + s, 0) / scores.length;
  const report: CaseReport = {
    id: kase.id,
    pass: error === undefined && Object.values(scorers).every((s) => s.pass),
    score: caseScore,
    scorers,
    latencyMs: Date.now() - started,
  };
  if (error !== undefined) report.error = error;
  return report;
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length }) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return out;
}
