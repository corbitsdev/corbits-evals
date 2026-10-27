import { matches } from "./checks.js";
import { fromJsonl } from "./datasets.js";
import { checkThresholds, type Ask, type Judge, type Sentence } from "./jev.js";
import {
  flips,
  fromReport,
  parseStored,
  toMarkdown,
  toStored,
  toSummary,
  type Experiment,
} from "./reports.js";
import { runCases, type NamedCase } from "./runner.js";
import { toTraced, type AgentLike, type Runnable } from "./runs.js";
import { toMs, type Duration } from "./timeout.js";
import type { Case, CaseResult, CheckFn, CheckResult, Report, Run } from "./types.js";

/** Code, a yes/no question for Jev, or `ask(...)`. */
export type Scorer<I = unknown, O = unknown, E = unknown> =
  | CheckFn<I, O, E>
  | string
  | Ask
  | Sentence;

/** Cases a check may miss, or `{ miss, drop }`; both default to 0. */
export type Allow = number | { miss?: number; drop?: number };

export type Evaluation<I, O, E> = {
  name: string;
  task: Runnable<I, O>;
  /** Case objects, or the path of a JSONL file of them. */
  data: readonly Case<I, E>[] | string;
  /** Defaults to `{ matches: matches() }`. */
  scorers?: Record<string, Scorer<I, O, E>>;
  /** Per scorer name. Unlisted scorers may miss no case and drop nothing. */
  allow?: Record<string, Allow>;
  /**
   * An experiment file's path, or an experiment, to measure drops against.
   * Never written; a missing file means drops are not gated.
   */
  compare?: string | Experiment;
  /** Path to store this experiment at, pass or fail. */
  save?: string;
  repeats?: number;
  concurrency?: number;
  /** Bounds each task and each scorer. A task that times out is aborted via its signal. */
  timeout?: Duration;
  /** Stamped into the experiment, e.g. `{ model }`. */
  about?: Record<string, unknown>;
  /** Jev for string and `ask` scorers. Those checks need `judge.invoke` from `judgeModel`. */
  judge?: Judge;
  /** Skip the console summary. */
  quiet?: boolean;
};

/** Thrown by `runEvaluation` when the gate fails; `report` holds every result. */
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
    throw new Error(`evaluation "${name}": ${key} must be a whole number >= 1`);
  }
  return raw;
}

function count(name: string, key: string, raw: unknown): number {
  if (raw === undefined) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`evaluation "${name}": ${key} must be a whole number >= 0`);
  }
  return raw;
}

type Allowance = CheckResult["allow"];

function toAllowances(
  name: string,
  allow: Record<string, Allow>,
  checks: readonly string[],
): Record<string, Allowance> {
  const unknown = Object.keys(allow).find((key) => !checks.includes(key));
  if (unknown !== undefined) {
    throw new Error(`evaluation "${name}": allow names unknown scorer "${unknown}"`);
  }
  return Object.fromEntries(
    checks.map((check) => {
      const raw: unknown = allow[check];
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return [check, { miss: count(name, `allow.${check}`, raw), drop: 0 }];
      }
      const extra = Object.keys(raw).find((key) => key !== "miss" && key !== "drop");
      if (extra !== undefined) {
        throw new Error(`evaluation "${name}": allow.${check} has unknown "${extra}"`);
      }
      const { miss, drop } = raw as { miss?: unknown; drop?: unknown };
      return [
        check,
        {
          miss: count(name, `allow.${check}.miss`, miss),
          drop: count(name, `allow.${check}.drop`, drop),
        },
      ];
    }),
  );
}

export function caseName(evalCase: Case<unknown, unknown>): string {
  if (evalCase.name !== undefined) return evalCase.name;
  return typeof evalCase.input === "string"
    ? evalCase.input
    : String(JSON.stringify(evalCase.input));
}

type Named<I, E> = NamedCase<I, E> & { must?: readonly string[] };

function named<I, E>(
  name: string,
  cases: readonly Case<I, E>[],
  checks: readonly string[],
): Named<I, E>[] {
  if (cases.length === 0) throw new Error(`evaluation "${name}" has no data`);
  const seen = new Set<string>();
  return cases.map((evalCase) => {
    const key = caseName(evalCase);
    if (seen.has(key)) throw new Error(`evaluation "${name}" has duplicate case "${key}"`);
    seen.add(key);
    for (const field of ["must", "skip"] as const) {
      const unknown = evalCase[field]?.find((check) => !checks.includes(check));
      if (unknown !== undefined) {
        throw new Error(
          `evaluation "${name}": case "${key}" ${field} names unknown scorer "${unknown}"`,
        );
      }
    }
    const both = evalCase.must?.find((check) => evalCase.skip?.includes(check));
    if (both !== undefined) {
      throw new Error(`evaluation "${name}": case "${key}" both must and skip "${both}"`);
    }
    return { ...evalCase, name: key };
  });
}

function toCheckParts<I, O, E>(
  name: string,
  checks: Record<string, Scorer<I, O, E>>,
): {
  code: Record<string, (run: Run<I, O, E>) => unknown>;
  jev: Record<string, Ask | Sentence | string>;
} {
  const entries = Object.entries(checks);
  if (entries.length === 0) throw new Error(`evaluation "${name}" has no scorers`);
  const code: Record<string, (run: Run<I, O, E>) => unknown> = {};
  const jev: Record<string, Ask | Sentence | string> = {};
  for (const [key, check] of entries) {
    if (typeof check === "function") {
      code[key] = check;
      continue;
    }
    const valid =
      typeof check === "string" ? check.trim() !== "" : typeof check?.question === "string";
    if (!valid) throw new Error(`evaluation "${name}": check "${key}" is not a scorer`);
    checkThresholds(check as Ask | Sentence);
    jev[key] = check as Ask | Sentence | string;
  }
  return { code, jev };
}

function score(
  results: readonly CaseResult[],
  cases: readonly Named<unknown, unknown>[],
  allowances: Record<string, Allowance>,
  stored: Experiment | undefined,
): { checks: Record<string, CheckResult>; reasons: string[] } {
  const must = new Map(cases.map((c) => [c.name, c.must ?? []]));
  const checks: Record<string, CheckResult> = {};
  const reasons: string[] = [];
  for (const [check, allow] of Object.entries(allowances)) {
    let passed = 0;
    let counted = 0;
    let drop = 0;
    const mustFailed: string[] = [];
    for (const c of results) {
      const o = c.checks[check];
      if (o === undefined) continue;
      counted += 1;
      if (o.pass) passed += 1;
      else {
        if (must.get(c.name)?.includes(check)) mustFailed.push(c.name);
        if (stored?.cases[c.name]?.[check]?.pass === true) drop += 1;
      }
    }
    const missed = counted - passed;
    const why = [
      ...(missed > allow.miss ? [`${check}: ${missed} missed, ${allow.miss} allowed`] : []),
      ...(drop > allow.drop ? [`${check}: ${drop} dropped, ${allow.drop} allowed`] : []),
      ...mustFailed.map((c) => `${check}: must pass "${c}"`),
    ];
    const result: CheckResult = {
      passed,
      counted,
      missed,
      allow,
      mustFailed,
      ok: why.length === 0,
    };
    if (stored !== undefined) result.drop = drop;
    checks[check] = result;
    reasons.push(...why);
  }
  return { checks, reasons };
}

async function toCompared(
  name: string,
  compare: string | Experiment | undefined,
): Promise<Experiment | undefined> {
  if (compare === undefined) return undefined;
  if (typeof compare !== "string") {
    if (compare.name !== name) {
      throw new Error(`evaluation "${name}": compare is an experiment of "${compare.name}"`);
    }
    return compare;
  }
  const file = Bun.file(compare);
  if (!(await file.exists())) return undefined;
  const stored = parseStored(await file.text(), compare);
  if (stored.name !== name) {
    throw new Error(`${compare}: stored experiment "${stored.name}", not "${name}"`);
  }
  return stored;
}

const SHOWN_FAILURES = 10;

function failures(cases: readonly CaseResult[], checks: Record<string, CheckResult>): string[] {
  const lines = cases.flatMap((c) =>
    Object.entries(c.checks)
      .filter(([check, o]) => !o.pass && checks[check]?.ok === false)
      .map(([check, o]) => `  ${c.name} / ${check}${o.explanation ? `: ${o.explanation}` : ""}`),
  );
  return lines.length > SHOWN_FAILURES
    ? [...lines.slice(0, SHOWN_FAILURES), `  ... ${lines.length - SHOWN_FAILURES} more`]
    : lines;
}

/**
 * Run every case, check it, print a summary, and gate. Rejects with
 * `EvalFailure` when a check misses or drops more cases than `allow` gives
 * it, or fails a case that `must` pass it.
 */
export async function runEvaluation<E = string>(
  spec: Evaluation<string, string, E> & { task: AgentLike },
): Promise<Report<string, string, E>>;
export async function runEvaluation<I, O, E = O>(
  spec: Evaluation<I, O, E>,
): Promise<Report<I, O, E>>;
export async function runEvaluation<I, O, E>(spec: Evaluation<I, O, E>): Promise<Report<I, O, E>> {
  const name = spec.name;
  if (typeof name !== "string" || name.trim() === "") throw new Error("runEvaluation needs a name");
  const repeats = positiveInt(name, "repeats", spec.repeats, 1);
  const concurrency = positiveInt(name, "concurrency", spec.concurrency, 4);
  const timeoutMs = spec.timeout === undefined ? undefined : toMs(spec.timeout, "timeout");
  let judge: Judge | undefined = spec.judge;
  const defined = spec.scorers ?? { matches: matches() as Scorer<I, O, E> };
  const { code, jev: jevChecks } = toCheckParts(name, defined);
  if (Object.keys(jevChecks).length > 0 && judge?.invoke === undefined) {
    throw new Error(
      `evaluation "${name}": string and ask checks need judge.invoke from judgeModel`,
    );
  }
  const checkNames = Object.keys(defined);
  const jevGroup =
    Object.keys(jevChecks).length === 0 || judge === undefined
      ? undefined
      : { judge, checks: jevChecks };
  const allowances = toAllowances(name, spec.allow ?? {}, checkNames);
  const cases = named(
    name,
    typeof spec.data === "string" ? ((await fromJsonl(spec.data)) as Case<I, E>[]) : spec.data,
    checkNames,
  );
  const run = toTraced(spec.task, "task");

  const stored = await toCompared(name, spec.compare);

  const results = await runCases({
    cases,
    run,
    checks: code,
    ...(jevGroup === undefined ? {} : { jev: jevGroup }),
    repeats,
    concurrency,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const scored = score(results, cases, allowances, stored);
  const data: Omit<Report<I, O, E>, "markdown" | "experiment"> = {
    name,
    ok: scored.reasons.length === 0,
    total: results.length,
    passed: results.filter((c) => c.pass).length,
    checks: scored.checks,
    cases: results,
  };
  if (spec.about !== undefined) data.about = { ...spec.about };
  if (stored !== undefined) {
    const before = stored.cases;
    const now = new Set(results.map((c) => c.name));
    data.changes = flips(stored, results);
    data.added = results.filter((c) => before[c.name] === undefined).map((c) => c.name);
    data.removed = Object.keys(before).filter((c) => !now.has(c));
  }
  const report: Report<I, O, E> = {
    ...data,
    experiment: fromReport(data),
    markdown: () => toMarkdown(data),
  };
  const log = spec.quiet === true ? () => {} : console.log;
  log(toSummary(data));
  if (typeof spec.compare === "string" && stored === undefined) {
    log(`  no compare run at ${spec.compare}`);
  }
  if (spec.save !== undefined) {
    await Bun.write(spec.save, toStored(data));
    log(`  wrote ${spec.save}`);
  }
  if (!report.ok) {
    throw new EvalFailure(
      [
        `evaluation "${name}" failed: ${scored.reasons.join("; ")}`,
        ...failures(results, scored.checks),
      ].join("\n"),
      report,
    );
  }
  return report;
}
