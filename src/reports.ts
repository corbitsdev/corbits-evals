import type { CaseResult, Change, Outcome, Report } from "./types.js";

type Row = Record<string, unknown>;

/** A report without its methods. */
export type ReportData = Omit<Report, "markdown" | "save">;

/** What a stored run keeps: per case × check pass and value. No times, so diffs stay quiet. */
export type Baseline = {
  eval: string;
  about?: Record<string, unknown>;
  passRate: number;
  cases: Record<string, Record<string, { pass: boolean; value: number }>>;
};

export const BASELINE_FORMAT = 1;

export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function toBaseline(report: ReportData): string {
  const cases: Baseline["cases"] = {};
  for (const c of report.cases) {
    cases[c.name] = Object.fromEntries(
      Object.entries(c.checks).map(([name, o]) => [name, { pass: o.pass, value: round(o.value) }]),
    );
  }
  const stored = {
    format: BASELINE_FORMAT,
    eval: report.name,
    ...(report.about === undefined ? {} : { about: report.about }),
    passRate: round(report.passRate),
    cases,
  };
  return `${JSON.stringify(stored, null, 2)}\n`;
}

function isObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stored(raw: unknown, where: string): { pass: boolean; value: number } {
  if (!isObject(raw) || typeof raw["pass"] !== "boolean") {
    throw new Error(`${where}: "pass" must be a boolean`);
  }
  const value = raw["value"];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${where}: "value" must be a finite number`);
  }
  return { pass: raw["pass"], value };
}

/** Throws on a missing or unknown `format` and on a malformed baseline. */
export function parseBaseline(text: string, source: string): Baseline {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${source}: invalid JSON (${(cause as Error).message})`);
  }
  if (!isObject(raw)) throw new Error(`${source}: expected an object`);
  if (raw["format"] !== BASELINE_FORMAT) {
    throw new Error(
      `${source}: unknown format ${JSON.stringify(raw["format"])}, expected ${BASELINE_FORMAT}`,
    );
  }
  const name = raw["eval"];
  if (typeof name !== "string" || name === "") {
    throw new Error(`${source}: "eval" must be a non-empty string`);
  }
  const passRate = raw["passRate"];
  if (typeof passRate !== "number" || !Number.isFinite(passRate)) {
    throw new Error(`${source}: "passRate" must be a finite number`);
  }
  if (!isObject(raw["cases"])) throw new Error(`${source}: "cases" must be an object`);
  const cases: Baseline["cases"] = {};
  for (const [caseName, checks] of Object.entries(raw["cases"])) {
    if (!isObject(checks)) throw new Error(`${source}: case "${caseName}" must be an object`);
    cases[caseName] = Object.fromEntries(
      Object.entries(checks).map(([check, o]) => [
        check,
        stored(o, `${source}: case "${caseName}" check "${check}"`),
      ]),
    );
  }
  const baseline: Baseline = { eval: name, passRate, cases };
  const about = raw["about"];
  if (about !== undefined) {
    if (!isObject(about)) throw new Error(`${source}: "about" must be an object`);
    baseline.about = about;
  }
  return baseline;
}

/** Case × check pass flips. Cases or checks on one side only are not changes. */
export function compare(baseline: Baseline, cases: readonly CaseResult[]): Change[] {
  const changes: Change[] = [];
  for (const c of cases) {
    const before = baseline.cases[c.name];
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

export function toMarkdown(report: ReportData): string {
  const names = Object.keys(report.checks);
  const lines = [
    `# eval: ${cell(report.name)}`,
    ``,
    `- cases: ${report.total}, passed: ${report.passed} (${(report.passRate * 100).toFixed(1)}%)`,
    `- result: ${report.ok ? "ok" : "FAILED"}`,
    ...(report.about === undefined ? [] : [`- about: ${cell(JSON.stringify(report.about))}`]),
    ...(report.changes === undefined
      ? []
      : report.changes.map((c) => `- ${c.change}: ${cell(c.case)} / ${cell(c.check)}`)),
    ``,
    `| case | ${names.map(cell).join(" | ")} |`,
    `| ---- | ${names.map(() => "----").join(" | ")} |`,
  ];
  for (const c of report.cases) {
    const cells = names.map((n) => {
      const o = c.checks[n];
      return o === undefined ? "" : `${o.pass ? "pass" : "FAIL"} ${cell(detail(o))}`;
    });
    lines.push(`| ${cell(c.name)} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

/** The console summary: per check passed/total, then any baseline changes. */
export function toSummary(report: ReportData): string {
  const entries = Object.entries(report.checks);
  const width = Math.max(5, ...entries.map(([name]) => name.length));
  const lines = [
    `${report.name}: ${report.passed}/${report.total} cases passed${report.ok ? "" : " (FAILED)"}`,
    ...entries.map(([name, t]) => `  ${name.padEnd(width)}  ${t.passed}/${t.total}`),
  ];
  for (const c of report.changes ?? []) lines.push(`  ${c.change}: ${c.case} / ${c.check}`);
  return lines.join("\n");
}
