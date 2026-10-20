import type { Decision } from "@corbits/system-one";

import { caseName } from "./evaluate.js";
import { DEFAULTS, decideBatch, toOutcome, type Ask, type Judge, type Sentence } from "./jev.js";
import { mapPool, runOnce, type RunSpec } from "./runner.js";
import { toTraced, type Runnable } from "./runs.js";
import { toMs, type Duration } from "./timeout.js";
import type { Outcome } from "./types.js";

/** A case with a known verdict per check, e.g. hand-labeled or from `must`. */
export type Labeled<I = unknown, E = unknown> = {
  name?: string;
  input: I;
  expect?: E;
  /** The expected verdict per check name. */
  labels: Readonly<Record<string, boolean>>;
};

export type CalibrateOptions<I, O, E> = {
  run: Runnable<I, O>;
  cases: readonly Labeled<I, E>[];
  checks: Record<string, Ask | Sentence | string>;
  judge: Judge;
  concurrency?: number;
  /** Bounds each case run. The Jev call is bounded by `judge.timeout`. */
  timeout?: Duration;
};

export type CalibrationRow = {
  threshold: number;
  agrees: number;
  unsure: number;
  disagrees: number;
};

export type CalibrationCheck = {
  rows: CalibrationRow[];
  /** The most permissive threshold with no confident disagreements. */
  recommended: number;
  /** The override to paste into the check or judge. */
  setting: string;
};

export type Calibration = {
  name: string;
  total: number;
  checks: Record<string, CalibrationCheck>;
  markdown(): string;
};

/** The sweep. 0.5 is chance for a binary; 0.95 leaves almost nothing unsure. */
const GRID = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function isUnsure(o: Outcome): boolean {
  return o.explanation?.startsWith("unsure (") === true;
}

/**
 * The sweep owns the bars: a check's own `sure`/`yes`/`no` overrides would
 * outrank every candidate judge (check-level wins over judge-level in
 * `thresholdsFor`), making every row identical and the recommendation a no-op.
 */
function sweepable(check: Ask | Sentence | string): Ask | Sentence | string {
  if (typeof check === "string") return check;
  const copy: Record<string, unknown> = { ...check };
  delete copy["sure"];
  delete copy["yes"];
  delete copy["no"];
  return copy as Ask | Sentence;
}

/**
 * Run a labeled sample through Jev once and sweep the pass bars, so
 * thresholds become a per-workload choice instead of a constant. Yes/no
 * checks sweep `yes` with `no` mirrored; `ask` sweeps `sure`.
 */
export async function calibrate<I, O, E = O>(
  name: string,
  options: CalibrateOptions<I, O, E>,
): Promise<Calibration> {
  if (name.trim() === "") throw new Error("calibrate needs a name");
  const names = Object.keys(options.checks);
  if (names.length === 0) throw new Error(`calibrate "${name}" has no checks`);
  const run = toTraced(options.run);
  const timeoutMs = options.timeout === undefined ? undefined : toMs(options.timeout, "timeout");
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`calibrate "${name}": concurrency must be a whole number >= 1`);
  }

  type Sample = { decision: Decision; label: boolean };
  const samples: Record<string, Sample[]> = {};
  for (const checkName of names) samples[checkName] = [];

  const spec: RunSpec<I, O, E> = {
    cases: [],
    run,
    checks: {},
    repeats: 1,
    concurrency: 1,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };

  await mapPool(options.cases, concurrency, async (labeled) => {
    const key = caseName(labeled);
    for (const checkName of names) {
      if (labeled.labels[checkName] === undefined) {
        throw new Error(`calibrate "${name}": case "${key}" has no label for check "${checkName}"`);
      }
    }
    const evalCase = {
      name: key,
      input: labeled.input,
      ...(labeled.expect === undefined ? {} : { expect: labeled.expect }),
    };
    const runResult = await runOnce(spec, evalCase);
    const decisions = await decideBatch(options.judge, options.checks, runResult);
    for (const checkName of names) {
      const decision = decisions[checkName];
      if (decision === undefined) {
        throw new Error(`calibrate "${name}": Jev returned no decision for "${checkName}"`);
      }
      samples[checkName]?.push({ decision, label: labeled.labels[checkName] as boolean });
    }
  });

  const checks: Record<string, CalibrationCheck> = {};
  for (const checkName of names) {
    const sample = samples[checkName] ?? [];
    const check = options.checks[checkName] as Ask | Sentence | string;
    const isQuestion =
      typeof check !== "string" &&
      (("options" in check && check.options !== undefined) ||
        ("levels" in check && check.levels !== undefined));
    const base = options.judge.thresholds ?? DEFAULTS;
    const rows: CalibrationRow[] = [];
    for (const threshold of GRID) {
      const judge: Judge = {
        config: {},
        thresholds: isQuestion
          ? { yes: base.yes, no: base.no, sure: threshold }
          : { yes: threshold, no: r3(1 - threshold), sure: base.sure },
      };
      let agrees = 0;
      let unsure = 0;
      let disagrees = 0;
      for (const s of sample) {
        const o = toOutcome(sweepable(check), s.decision, judge);
        if (isUnsure(o)) unsure += 1;
        else if (o.pass === s.label) agrees += 1;
        else disagrees += 1;
      }
      rows.push({ threshold, agrees, unsure, disagrees });
    }
    const clean = rows.find((row) => row.disagrees === 0);
    const recommended =
      clean?.threshold ?? rows.reduce((a, b) => (b.disagrees <= a.disagrees ? b : a)).threshold;
    const setting = isQuestion
      ? `{ sure: ${recommended} }`
      : `{ yes: ${recommended}, no: ${r3(1 - recommended)} }`;
    checks[checkName] = { rows, recommended, setting };
  }

  const data = { name, total: options.cases.length, checks };
  return { ...data, markdown: () => toMarkdown(data) };
}

function toMarkdown(data: {
  name: string;
  total: number;
  checks: Record<string, CalibrationCheck>;
}): string {
  const lines = [`# calibrate: ${data.name}`, ``, `- cases: ${data.total}`, ``];
  for (const [checkName, t] of Object.entries(data.checks)) {
    lines.push(
      `## ${checkName}`,
      ``,
      `| threshold | agrees | unsure | disagrees |`,
      `| --- | --- | --- | --- |`,
    );
    for (const row of t.rows) {
      lines.push(`| ${row.threshold} | ${row.agrees} | ${row.unsure} | ${row.disagrees} |`);
    }
    lines.push(``, `recommended: \`${t.setting}\``, ``);
  }
  return lines.join("\n");
}
