import { toOutcome } from "./checks.js";
import type { Trace } from "./runs.js";
import { withTimeout } from "./timeout.js";
import type { CaseResult, Outcome, Run } from "./types.js";

export type NamedCase<I, E> = { name: string; input: I; expect?: E; skip?: readonly string[] };

export type RunSpec<I, O, E> = {
  cases: readonly NamedCase<I, E>[];
  run: (input: I, signal: AbortSignal) => Promise<Trace<O>>;
  checks: Record<string, (run: Run<I, O, E>) => unknown>;
  repeats: number;
  concurrency: number;
  /** Bounds the run and each check per attempt. */
  timeoutMs?: number;
};

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function runOnce<I, O, E>(
  spec: RunSpec<I, O, E>,
  evalCase: NamedCase<I, E>,
): Promise<Run<I, O, E>> {
  const { timeoutMs } = spec;
  const controller = new AbortController();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    if (timeoutMs === undefined) return;
    timer = setTimeout(() => {
      const error = new Error(`case "${evalCase.name}" timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const trace = await Promise.race([spec.run(evalCase.input, controller.signal), expiry]);
    const run: Run<I, O, E> = {
      input: evalCase.input,
      output: trace.output,
      steps: trace.steps,
      ms: Date.now() - started,
    };
    if (evalCase.expect !== undefined) run.expect = evalCase.expect;
    return run;
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck<I, O, E>(
  name: string,
  check: (run: Run<I, O, E>) => unknown,
  run: Run<I, O, E>,
  timeoutMs: number | undefined,
): Promise<Outcome> {
  try {
    const pending = Promise.resolve(check(run));
    const raw =
      timeoutMs === undefined
        ? await pending
        : await withTimeout(pending, timeoutMs, `check "${name}" timed out after ${timeoutMs}ms`);
    return toOutcome(name, raw);
  } catch (cause) {
    return { pass: false, value: 0, explanation: `check "${name}" threw: ${message(cause)}` };
  }
}

function compileAttempts(attempts: readonly Outcome[]): Outcome {
  const first = attempts[0];
  if (first === undefined) return { pass: false, value: 0, explanation: "no attempts" };
  if (attempts.length === 1) return first;
  const failed = attempts.filter((o) => !o.pass);
  // Report the attempt that decided the outcome, never a passing label on a failed check.
  const decider = failed[0] ?? first;
  const compiled: Outcome = {
    pass: failed.length === 0,
    value: attempts.reduce((t, o) => t + o.value, 0) / attempts.length,
    explanation: `${attempts.length - failed.length}/${attempts.length} attempts passed${
      decider.explanation === undefined ? "" : `; ${decider.explanation}`
    }`,
  };
  if (decider.label !== undefined) compiled.label = decider.label;
  return compiled;
}

async function runCase<I, O, E>(
  spec: RunSpec<I, O, E>,
  evalCase: NamedCase<I, E>,
): Promise<CaseResult<I, O, E>> {
  const started = Date.now();
  const entries = Object.entries(spec.checks).filter(([name]) => !evalCase.skip?.includes(name));
  const attempts: Record<string, Outcome[]> = {};
  for (const [name] of entries) attempts[name] = [];
  let last: Run<I, O, E> | undefined;
  let error: string | undefined;
  for (let attempt = 0; attempt < spec.repeats; attempt += 1) {
    try {
      last = await runOnce(spec, evalCase);
    } catch (cause) {
      error = message(cause);
      break;
    }
    const run = last;
    const outcomes = await Promise.all(
      entries.map(([name, check]) => runCheck(name, check, run, spec.timeoutMs)),
    );
    entries.forEach(([name], i) => attempts[name]?.push(outcomes[i] as Outcome));
  }
  const checks: Record<string, Outcome> = {};
  for (const [name] of entries) {
    // A run error fails every check so partial repeats never pass a case.
    checks[name] =
      error === undefined
        ? compileAttempts(attempts[name] ?? [])
        : { pass: false, value: 0, explanation: `run failed: ${error}` };
  }
  const result: CaseResult<I, O, E> = {
    name: evalCase.name,
    input: evalCase.input,
    steps: last?.steps ?? [],
    ms: Date.now() - started,
    pass: error === undefined && Object.values(checks).every((o) => o.pass),
    checks,
  };
  if (evalCase.expect !== undefined) result.expect = evalCase.expect;
  if (last !== undefined) result.output = last.output;
  if (error !== undefined) result.error = error;
  return result;
}

export async function runCases<I, O, E>(spec: RunSpec<I, O, E>): Promise<CaseResult<I, O, E>[]> {
  return mapPool(spec.cases, spec.concurrency, (evalCase) => runCase(spec, evalCase));
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length }) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return out;
}
