import { matches } from "./checks.js";
import { fromJsonl } from "./datasets.js";
import { askJev, jev, type Ask, type Judge } from "./jev.js";
import {
  compare,
  parseBaseline,
  round,
  toBaseline,
  toMarkdown,
  toSummary,
  type Baseline,
} from "./reports.js";
import { runCases, type NamedCase } from "./runner.js";
import { toTraced, type AgentLike, type Runnable } from "./runs.js";
import { toMs, type Duration } from "./timeout.js";
import type { Case, CaseResult, CheckFn, Report, Run } from "./types.js";

/** Code, a yes/no question for Jev, or `ask(...)`. */
export type Check<I = unknown, O = unknown, E = unknown> = CheckFn<I, O, E> | string | Ask;

export type EvaluateOptions<I, O, E> = {
  run: Runnable<I, O>;
  /** Case objects, or the path of a JSONL file of them. */
  cases: readonly Case<I, E>[] | string;
  /** Defaults to `{ matches: matches() }`. */
  checks?: Record<string, Check<I, O, E>>;
  /** Path of a stored run to compare with. Missing fails; `update` creates it. */
  baseline?: string;
  /** Defaults to 1, or to the stored pass rate when comparing with a baseline. */
  passRate?: number;
  repeats?: number;
  concurrency?: number;
  /** Bounds each run and each check. A run that times out is aborted via its signal. */
  timeout?: Duration;
  /** Stamped into the stored run, e.g. `{ model }`. */
  about?: Record<string, unknown>;
  /** Jev for string and `ask` checks. Defaults to `jev()`. */
  judge?: Judge;
  /** Write the baseline instead of gating on it. Defaults to `CORBITS_EVALS_UPDATE=1`. */
  update?: boolean;
  /** Skip the console summary. */
  quiet?: boolean;
};

/** Thrown by `evaluate` when the gate fails; `report` holds every result. */
export class EvalFailure extends Error {
  readonly report: Report;
  constructor(message: string, report: Report) {
    super(message);
    this.name = "EvalFailure";
    this.report = report;
  }
}

function positiveInt(name: string, key: string, raw: number | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!Number.isInteger(raw) || raw < 1) {
    throw new Error(`eval "${name}": ${key} must be a whole number >= 1`);
  }
  return raw;
}

function caseName(evalCase: Case<unknown, unknown>): string {
  if (evalCase.name !== undefined) return evalCase.name;
  return typeof evalCase.input === "string"
    ? evalCase.input
    : String(JSON.stringify(evalCase.input));
}

function named<I, E>(name: string, cases: readonly Case<I, E>[]): NamedCase<I, E>[] {
  if (cases.length === 0) throw new Error(`eval "${name}" has no cases`);
  const seen = new Set<string>();
  return cases.map((evalCase) => {
    const key = caseName(evalCase);
    if (seen.has(key)) throw new Error(`eval "${name}" has duplicate case "${key}"`);
    seen.add(key);
    return { ...evalCase, name: key };
  });
}

function toCheckFns<I, O, E>(
  name: string,
  checks: Record<string, Check<I, O, E>>,
  judge: () => Judge,
): Record<string, (run: Run<I, O, E>) => unknown> {
  const entries = Object.entries(checks);
  if (entries.length === 0) throw new Error(`eval "${name}" has no checks`);
  return Object.fromEntries(
    entries.map(([key, check]) => {
      if (typeof check === "function") return [key, check];
      const valid =
        typeof check === "string" ? check.trim() !== "" : typeof check?.question === "string";
      if (!valid) throw new Error(`eval "${name}": check "${key}" is not a check`);
      return [key, (run: Run<I, O, E>) => askJev(judge(), check, run as Run)];
    }),
  );
}

function tally(cases: readonly CaseResult[]): Record<string, { passed: number; total: number }> {
  const out: Record<string, { passed: number; total: number }> = {};
  for (const c of cases) {
    for (const [name, o] of Object.entries(c.checks)) {
      const t = (out[name] ??= { passed: 0, total: 0 });
      t.total += 1;
      if (o.pass) t.passed += 1;
    }
  }
  return out;
}

const SHOWN_FAILURES = 10;

function failures(cases: readonly CaseResult[]): string[] {
  const lines = cases.flatMap((c) =>
    Object.entries(c.checks)
      .filter(([, o]) => !o.pass)
      .map(([check, o]) => `  ${c.name} / ${check}${o.explanation ? `: ${o.explanation}` : ""}`),
  );
  return lines.length > SHOWN_FAILURES
    ? [...lines.slice(0, SHOWN_FAILURES), `  ... ${lines.length - SHOWN_FAILURES} more`]
    : lines;
}

/**
 * Run every case, check it, print a summary, and gate. Rejects with
 * `EvalFailure` when the pass rate is missed or a case × check that passed
 * in the baseline fails now. Writing a baseline gates only on an explicit
 * `passRate`.
 */
export async function evaluate<E = string>(
  name: string,
  options: EvaluateOptions<string, string, E> & { run: AgentLike },
): Promise<Report<string, string, E>>;
export async function evaluate<I, O, E = O>(
  name: string,
  options: EvaluateOptions<I, O, E>,
): Promise<Report<I, O, E>>;
export async function evaluate<I, O, E>(
  name: string,
  options: EvaluateOptions<I, O, E>,
): Promise<Report<I, O, E>> {
  if (name.trim() === "") throw new Error("evaluate needs a name");
  const { passRate } = options;
  if (passRate !== undefined && !(Number.isFinite(passRate) && passRate >= 0 && passRate <= 1)) {
    throw new Error(`eval "${name}": passRate must be between 0 and 1`);
  }
  const repeats = positiveInt(name, "repeats", options.repeats, 1);
  const concurrency = positiveInt(name, "concurrency", options.concurrency, 4);
  const timeoutMs = options.timeout === undefined ? undefined : toMs(options.timeout, "timeout");
  let judge: Judge | undefined = options.judge;
  const checks = toCheckFns(
    name,
    options.checks ?? { matches: matches() as Check<I, O, E> },
    () => (judge ??= jev()),
  );
  const cases = named(
    name,
    typeof options.cases === "string"
      ? ((await fromJsonl(options.cases)) as Case<I, E>[])
      : options.cases,
  );
  const run = toTraced(options.run);

  const update = options.update ?? process.env["CORBITS_EVALS_UPDATE"] === "1";
  let baseline: Baseline | undefined;
  if (options.baseline !== undefined) {
    const file = Bun.file(options.baseline);
    if (await file.exists()) {
      baseline = parseBaseline(await file.text(), options.baseline);
      if (baseline.eval !== name) {
        throw new Error(
          `${options.baseline}: stored run of eval "${baseline.eval}", not "${name}"`,
        );
      }
    } else if (!update) {
      throw new Error(
        `eval "${name}": baseline ${options.baseline} does not exist; run with CORBITS_EVALS_UPDATE=1 (or update: true) to create it`,
      );
    }
  }
  const writing = options.baseline !== undefined && update;

  const results = await runCases({
    cases,
    run,
    checks,
    repeats,
    concurrency,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const passed = results.filter((c) => c.pass).length;
  const rate = passed / results.length;
  const changes = baseline === undefined ? undefined : compare(baseline, results);
  const gating = baseline !== undefined && !writing;
  const broke = gating ? (changes ?? []).filter((c) => c.change === "broke") : [];
  const floor = passRate ?? (writing ? 0 : (baseline?.passRate ?? 1));
  // The stored rate is rounded, so compare like with like.
  const rateMet = (passRate === undefined && gating ? round(rate) : rate) >= floor;
  const data: Omit<Report<I, O, E>, "markdown" | "save"> = {
    name,
    ok: rateMet && broke.length === 0,
    total: results.length,
    passed,
    passRate: rate,
    checks: tally(results),
    cases: results,
  };
  if (options.about !== undefined) data.about = { ...options.about };
  if (changes !== undefined) data.changes = changes;
  const report: Report<I, O, E> = {
    ...data,
    markdown: () => toMarkdown(data),
    save: async (path) => {
      await Bun.write(path, toBaseline(data));
    },
  };
  const log = options.quiet === true ? () => {} : console.log;
  log(toSummary(data));
  if (writing && options.baseline !== undefined) {
    await report.save(options.baseline);
    log(`  wrote ${options.baseline}`);
  }
  if (!report.ok) {
    const reasons = [
      ...(rateMet ? [] : [`pass rate ${round(rate)} (${passed}/${results.length}) < ${floor}`]),
      ...broke.map((c) => `broke ${c.case} / ${c.check}`),
    ];
    throw new EvalFailure(
      [`eval "${name}" failed: ${reasons.join("; ")}`, ...failures(results)].join("\n"),
      report,
    );
  }
  return report;
}
