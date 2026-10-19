import { matches } from "./checks.js";
import { fromJsonl } from "./datasets.js";
import { checkThresholds, jev, type Ask, type Judge, type Sentence } from "./jev.js";
import {
  flips,
  fromReport,
  parseStored,
  toMarkdown,
  toStored,
  toSummary,
  type Stored,
} from "./reports.js";
import { runCases, type NamedCase } from "./runner.js";
import { toTraced, type AgentLike, type Runnable } from "./runs.js";
import { toMs, type Duration } from "./timeout.js";
import type { Case, CaseResult, CheckFn, CheckResult, Report, Run } from "./types.js";

/** Code, a yes/no question for Jev, or `ask(...)`. */
export type Check<I = unknown, O = unknown, E = unknown> =
  | CheckFn<I, O, E>
  | string
  | Ask
  | Sentence;

/** Cases a check may miss, or `{ miss, drop }`; both default to 0. */
export type Allow = number | { miss?: number; drop?: number };

export type EvaluateOptions<I, O, E> = {
  run: Runnable<I, O>;
  /** Case objects, or the path of a JSONL file of them. */
  cases: readonly Case<I, E>[] | string;
  /** Defaults to `{ matches: matches() }`. */
  checks?: Record<string, Check<I, O, E>>;
  /** Per check name. Unlisted checks may miss no case and drop nothing. */
  allow?: Record<string, Allow>;
  /**
   * A stored run's path or a previous report to measure drops against.
   * Never written; a missing file means drops are not gated.
   */
  compare?: string | Report;
  /** Path to store this run at, pass or fail. */
  save?: string;
  repeats?: number;
  concurrency?: number;
  /** Bounds each run and each check. A run that times out is aborted via its signal. */
  timeout?: Duration;
  /** Stamped into the stored run, e.g. `{ model }`. */
  about?: Record<string, unknown>;
  /** Jev for string and `ask` checks. Defaults to `jev()`. */
  judge?: Judge;
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

function count(name: string, key: string, raw: unknown): number {
  if (raw === undefined) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`eval "${name}": ${key} must be a whole number >= 0`);
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
    throw new Error(`eval "${name}": allow names unknown check "${unknown}"`);
  }
  return Object.fromEntries(
    checks.map((check) => {
      const raw: unknown = allow[check];
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return [check, { miss: count(name, `allow.${check}`, raw), drop: 0 }];
      }
      const extra = Object.keys(raw).find((key) => key !== "miss" && key !== "drop");
      if (extra !== undefined) {
        throw new Error(`eval "${name}": allow.${check} has unknown "${extra}"`);
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

function caseName(evalCase: Case<unknown, unknown>): string {
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
  if (cases.length === 0) throw new Error(`eval "${name}" has no cases`);
  const seen = new Set<string>();
  return cases.map((evalCase) => {
    const key = caseName(evalCase);
    if (seen.has(key)) throw new Error(`eval "${name}" has duplicate case "${key}"`);
    seen.add(key);
    for (const field of ["must", "skip"] as const) {
      const unknown = evalCase[field]?.find((check) => !checks.includes(check));
      if (unknown !== undefined) {
        throw new Error(`eval "${name}": case "${key}" ${field} names unknown check "${unknown}"`);
      }
    }
    const both = evalCase.must?.find((check) => evalCase.skip?.includes(check));
    if (both !== undefined) {
      throw new Error(`eval "${name}": case "${key}" both must and skip "${both}"`);
    }
    return { ...evalCase, name: key };
  });
}

function toCheckParts<I, O, E>(
  name: string,
  checks: Record<string, Check<I, O, E>>,
): {
  code: Record<string, (run: Run<I, O, E>) => unknown>;
  jev: Record<string, Ask | Sentence | string>;
} {
  const entries = Object.entries(checks);
  if (entries.length === 0) throw new Error(`eval "${name}" has no checks`);
  const code: Record<string, (run: Run<I, O, E>) => unknown> = {};
  const jev: Record<string, Ask | Sentence | string> = {};
  for (const [key, check] of entries) {
    if (typeof check === "function") {
      code[key] = check;
      continue;
    }
    const valid =
      typeof check === "string" ? check.trim() !== "" : typeof check?.question === "string";
    if (!valid) throw new Error(`eval "${name}": check "${key}" is not a check`);
    checkThresholds(check as Ask | Sentence);
    jev[key] = check as Ask | Sentence | string;
  }
  return { code, jev };
}

function score(
  results: readonly CaseResult[],
  cases: readonly Named<unknown, unknown>[],
  allowances: Record<string, Allowance>,
  stored: Stored | undefined,
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
  compare: string | Report | undefined,
): Promise<Stored | undefined> {
  if (compare === undefined) return undefined;
  if (typeof compare !== "string") {
    if (compare.name !== name) {
      throw new Error(`eval "${name}": compare is a report of eval "${compare.name}"`);
    }
    return fromReport(compare);
  }
  const file = Bun.file(compare);
  if (!(await file.exists())) return undefined;
  const stored = parseStored(await file.text(), compare);
  if (stored.eval !== name) {
    throw new Error(`${compare}: stored run of eval "${stored.eval}", not "${name}"`);
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
  const repeats = positiveInt(name, "repeats", options.repeats, 1);
  const concurrency = positiveInt(name, "concurrency", options.concurrency, 4);
  const timeoutMs = options.timeout === undefined ? undefined : toMs(options.timeout, "timeout");
  let judge: Judge | undefined = options.judge;
  const defined = options.checks ?? { matches: matches() as Check<I, O, E> };
  const { code, jev: jevChecks } = toCheckParts(name, defined);
  const checkNames = Object.keys(defined);
  const jevGroup =
    Object.keys(jevChecks).length === 0
      ? undefined
      : { judge: (judge ??= jev()), checks: jevChecks };
  const allowances = toAllowances(name, options.allow ?? {}, checkNames);
  const cases = named(
    name,
    typeof options.cases === "string"
      ? ((await fromJsonl(options.cases)) as Case<I, E>[])
      : options.cases,
    checkNames,
  );
  const run = toTraced(options.run);

  const stored = await toCompared(name, options.compare);

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
  const data: Omit<Report<I, O, E>, "markdown"> = {
    name,
    ok: scored.reasons.length === 0,
    total: results.length,
    passed: results.filter((c) => c.pass).length,
    checks: scored.checks,
    cases: results,
  };
  if (options.about !== undefined) data.about = { ...options.about };
  if (stored !== undefined) {
    const before = stored.cases;
    const now = new Set(results.map((c) => c.name));
    data.changes = flips(stored, results);
    data.added = results.filter((c) => before[c.name] === undefined).map((c) => c.name);
    data.removed = Object.keys(before).filter((c) => !now.has(c));
  }
  const report: Report<I, O, E> = { ...data, markdown: () => toMarkdown(data) };
  const log = options.quiet === true ? () => {} : console.log;
  log(toSummary(data));
  if (typeof options.compare === "string" && stored === undefined) {
    log(`  no compare run at ${options.compare}`);
  }
  if (options.save !== undefined) {
    await Bun.write(options.save, toStored(data));
    log(`  wrote ${options.save}`);
  }
  if (!report.ok) {
    throw new EvalFailure(
      [
        `eval "${name}" failed: ${scored.reasons.join("; ")}`,
        ...failures(results, scored.checks),
      ].join("\n"),
      report,
    );
  }
  return report;
}
