import type { CaseResult, Change, CheckResult, Outcome, Report } from "./types.js";

type Row = Record<string, unknown>;

/** A report without its methods or its experiment. */
export type ReportData = Omit<Report, "markdown" | "experiment">;

/** Per case × scorer pass and value, without times, so it diffs cleanly in git. */
export type Experiment = {
  name: string;
  about?: Record<string, unknown>;
  cases: Record<string, Record<string, ExperimentRow>>;
};

/** One scorer's stored answer: the outcome plus a Jev distribution when present. */
export type ExperimentRow = {
  pass: boolean;
  value: number;
  probabilities?: Record<string, number>;
  confidence?: number;
};

const STORED_FORMAT = 2;

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function fromReport(report: ReportData): Experiment {
  const cases: Experiment["cases"] = {};
  for (const c of report.cases) {
    cases[c.name] = Object.fromEntries(
      Object.entries(c.checks).map(([name, o]) => [
        name,
        {
          pass: o.pass,
          value: round(o.value),
          ...(o.probabilities === undefined
            ? {}
            : {
                probabilities: Object.fromEntries(
                  Object.entries(o.probabilities).map(([key, v]) => [key, round(v)]),
                ),
              }),
          ...(o.confidence === undefined ? {} : { confidence: round(o.confidence) }),
        },
      ]),
    );
  }
  return {
    name: report.name,
    ...(report.about === undefined ? {} : { about: report.about }),
    cases,
  };
}

export function toStored(report: ReportData): string {
  return `${JSON.stringify({ format: STORED_FORMAT, ...fromReport(report) }, null, 2)}\n`;
}

function isObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stored(raw: unknown, where: string): ExperimentRow {
  if (!isObject(raw) || typeof raw["pass"] !== "boolean") {
    throw new Error(`${where}: "pass" must be a boolean`);
  }
  const value = raw["value"];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${where}: "value" must be a finite number`);
  }
  const row: ExperimentRow = { pass: raw["pass"], value };
  const probabilities = raw["probabilities"];
  if (probabilities !== undefined) {
    if (!isObject(probabilities)) {
      throw new Error(`${where}: "probabilities" must be an object`);
    }
    for (const [key, v] of Object.entries(probabilities)) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`${where}: probabilities.${key} must be a finite number`);
      }
    }
    row.probabilities = probabilities as Record<string, number>;
  }
  const confidence = raw["confidence"];
  if (confidence !== undefined) {
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
      throw new Error(`${where}: "confidence" must be a finite number`);
    }
    row.confidence = confidence;
  }
  return row;
}

export function parseStored(text: string, source: string): Experiment {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${source}: invalid JSON (${(cause as Error).message})`);
  }
  if (!isObject(raw)) throw new Error(`${source}: expected an object`);
  if (raw["format"] !== STORED_FORMAT) {
    throw new Error(
      `${source}: unknown format ${JSON.stringify(raw["format"])}, expected ${STORED_FORMAT}`,
    );
  }
  const name = raw["name"];
  if (typeof name !== "string" || name === "") {
    throw new Error(`${source}: "name" must be a non-empty string`);
  }
  if (!isObject(raw["cases"])) throw new Error(`${source}: "cases" must be an object`);
  const cases: Experiment["cases"] = {};
  for (const [caseName, checks] of Object.entries(raw["cases"])) {
    if (!isObject(checks)) throw new Error(`${source}: case "${caseName}" must be an object`);
    cases[caseName] = Object.fromEntries(
      Object.entries(checks).map(([check, o]) => [
        check,
        stored(o, `${source}: case "${caseName}" check "${check}"`),
      ]),
    );
  }
  const run: Experiment = { name, cases };
  const about = raw["about"];
  if (about !== undefined) {
    if (!isObject(about)) throw new Error(`${source}: "about" must be an object`);
    run.about = about;
  }
  return run;
}

/** Case × check pass flips. Cases or checks on one side only are not changes. */
export function flips(stored: Experiment, cases: readonly CaseResult[]): Change[] {
  const changes: Change[] = [];
  for (const c of cases) {
    const before = stored.cases[c.name];
    if (before === undefined) continue;
    for (const [check, now] of Object.entries(c.checks)) {
      const was = before[check];
      if (was === undefined || was.pass === now.pass) continue;
      changes.push({ case: c.name, check, change: now.pass ? "fixed" : "broke" });
    }
  }
  return changes;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function detail(o: Outcome): string {
  const shown = o.label ?? o.value.toFixed(2);
  return o.explanation === undefined ? shown : `${shown}: ${o.explanation}`;
}

function allowed(n: number, allow: number): string {
  return `${n} (${allow} allowed)`;
}

function caseList(label: string, names: readonly string[] | undefined): string[] {
  return names === undefined || names.length === 0 ? [] : [`${label}: ${names.join(", ")}`];
}

export function toMarkdown(report: ReportData): string {
  const names = Object.keys(report.checks);
  const comparing = report.changes !== undefined;
  const lines = [
    `# evaluation: ${cell(report.name)}`,
    ``,
    `- cases: ${report.total}, passed: ${report.passed}`,
    `- result: ${report.ok ? "ok" : "FAILED"}`,
    ...(report.about === undefined ? [] : [`- about: ${cell(JSON.stringify(report.about))}`]),
    ...(report.changes ?? []).map((c) => `- ${c.change}: ${cell(c.case)} / ${cell(c.check)}`),
    ...caseList("added", report.added).map((l) => `- ${cell(l)}`),
    ...caseList("removed", report.removed).map((l) => `- ${cell(l)}`),
    ``,
    `| check | passed | misses |${comparing ? " drops |" : ""} result |`,
    `| ----- | ------ | ------ |${comparing ? " ----- |" : ""} ------ |`,
    ...Object.entries(report.checks).map(([name, t]) => {
      const drop = t.drop === undefined ? "" : ` ${allowed(t.drop, t.allow.drop)} |`;
      return `| ${cell(name)} | ${t.passed}/${t.counted} | ${allowed(t.missed, t.allow.miss)} |${drop} ${t.ok ? "ok" : "FAIL"} |`;
    }),
    ``,
    `| case | ${names.map(cell).join(" | ")} |`,
    `| ---- | ${names.map(() => "----").join(" | ")} |`,
  ];
  for (const c of report.cases) {
    const cells = names.map((n) => {
      const o = c.checks[n];
      return o === undefined ? "skip" : `${o.pass ? "pass" : "FAIL"} ${cell(detail(o))}`;
    });
    lines.push(`| ${cell(c.name)} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function summaryLine(name: string, t: CheckResult, width: number): string {
  const parts = [
    `  ${name.padEnd(width)}  ${t.passed}/${t.counted}`,
    `misses ${allowed(t.missed, t.allow.miss)}`,
    ...(t.drop === undefined ? [] : [`drops ${allowed(t.drop, t.allow.drop)}`]),
    ...(t.ok ? [] : ["FAILED"]),
  ];
  return parts.join("  ");
}

/** The console summary: per check passed/counted against its allowance, then changes. */
export function toSummary(report: ReportData): string {
  const entries = Object.entries(report.checks);
  const width = Math.max(5, ...entries.map(([name]) => name.length));
  const lines = [
    `${report.name}: ${report.passed}/${report.total} cases passed${report.ok ? "" : " (FAILED)"}`,
    ...entries.map(([name, t]) => summaryLine(name, t, width)),
    ...(report.changes ?? []).map((c) => `  ${c.change}: ${c.case} / ${c.check}`),
    ...caseList("added", report.added).map((l) => `  ${l}`),
    ...caseList("removed", report.removed).map((l) => `  ${l}`),
  ];
  return lines.join("\n");
}
