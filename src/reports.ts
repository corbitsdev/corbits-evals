import { describe, validateScorerResult } from "./results.js";
import type { CaseReport, EvalReport, ScorerVerdict } from "./types.js";

type Row = Record<string, unknown>;

// XML 1.0 forbids most C0 controls; LLM-derived text can carry them.
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function esc(s: string): string {
  return s
    .replace(XML_ILLEGAL, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function scorerSummary(caseReport: CaseReport): string {
  return Object.entries(caseReport.scorers)
    .map(([name, v]) => `${name}=${v.label ?? describe(v.result)}${v.pass ? "" : " ✗"}`)
    .join(", ");
}

function failureDetail(caseReport: CaseReport): string {
  const lines = Object.entries(caseReport.scorers)
    .filter(([, v]) => !v.pass)
    .map(([name, v]) => `${name}: ${v.explanation ?? `score ${v.score.toFixed(3)}`}`);
  return lines.length === 0 ? `score ${caseReport.score.toFixed(3)}` : lines.join("\n");
}

/** One-line markdown summary plus per-case table. */
export function toMarkdown(report: EvalReport): string {
  const lines = [
    `# eval: ${cell(report.eval)}`,
    ``,
    `- started: ${cell(report.startedAt)}`,
    `- cases: ${report.total}, passed: ${report.passed} (${(report.passRate * 100).toFixed(1)}%)`,
    `- avg score: ${report.avgScore.toFixed(3)}`,
    `- thresholds: ${report.thresholdsMet ? "met" : "NOT met"}`,
    ...(report.metadata === undefined
      ? []
      : [`- metadata: ${cell(JSON.stringify(report.metadata))}`]),
    ``,
    `| case | pass | score | detail |`,
    `| ---- | ---- | ----- | ------ |`,
  ];
  for (const caseReport of report.cases) {
    const detail =
      caseReport.error === undefined ? scorerSummary(caseReport) : `error: ${caseReport.error}`;
    lines.push(
      `| ${cell(caseReport.id)} | ${caseReport.pass ? "yes" : "no"} | ${caseReport.score.toFixed(3)} | ${cell(detail)} |`,
    );
  }
  return lines.join("\n");
}

/**
 * JUnit XML for CI. One testcase per case: `<error>` when the task threw or
 * timed out, `<failure>` when scorers rejected it. A final `thresholds`
 * testcase carries the eval-level gate so CI can key on it.
 */
export function toJUnit(report: EvalReport): string {
  const cases = report.cases.map((caseReport) => {
    let body = "";
    if (caseReport.error !== undefined) {
      body = `    <error message="task error">${esc(caseReport.error)}</error>\n`;
    } else if (!caseReport.pass) {
      body = `    <failure message="case failed">${esc(failureDetail(caseReport))}</failure>\n`;
    }
    return `  <testcase classname="${esc(report.eval)}" name="${esc(caseReport.id)}" time="${(caseReport.latencyMs / 1000).toFixed(3)}">\n${body}  </testcase>`;
  });
  const gate = report.thresholdsMet
    ? ""
    : `    <failure message="thresholds not met">passRate ${report.passRate.toFixed(3)}, avgScore ${report.avgScore.toFixed(3)}</failure>\n`;
  cases.push(
    `  <testcase classname="${esc(report.eval)}" name="thresholds" time="0.000">\n${gate}  </testcase>`,
  );
  const errors = report.cases.filter((c) => c.error !== undefined).length;
  const failures = report.total - report.passed - errors + (report.thresholdsMet ? 0 : 1);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${esc(report.eval)}" tests="${report.total + 1}" failures="${failures}" errors="${errors}">\n${cases.join("\n")}\n</testsuite>`;
}

export const REPORT_FORMAT_VERSION = 1;

/** Stable JSON for storage. Store it wherever you like, load it with `parseReport`, diff with `diffReports`. */
export function toJson(report: EvalReport): string {
  return JSON.stringify({ format: REPORT_FORMAT_VERSION, ...report }, null, 2);
}

function isObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(row: Row, key: string, where: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${where}: "${key}" must be a finite number`);
  }
  return value;
}

function bool(row: Row, key: string, where: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new Error(`${where}: "${key}" must be a boolean`);
  return value;
}

function optionalString(row: Row, key: string, where: string): string | undefined {
  const value = row[key];
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${where}: "${key}" must be a string`);
  }
  return value;
}

function optionalObject(row: Row, key: string, where: string): Row | undefined {
  const value = row[key];
  if (value !== undefined && !isObject(value)) {
    throw new Error(`${where}: "${key}" must be an object`);
  }
  return value;
}

function toVerdict(name: string, raw: unknown, where: string): ScorerVerdict {
  const checked = validateScorerResult(name, raw);
  if (typeof checked === "string") throw new Error(`${where}: ${checked}`);
  const row = raw as Row;
  const at = `${where}: scorer "${name}"`;
  const verdict: ScorerVerdict = {
    result: checked.result,
    pass: bool(row, "pass", at),
    score: finite(row, "score", at),
  };
  const label = optionalString(row, "label", at);
  if (label !== undefined) verdict.label = label;
  const explanation = optionalString(row, "explanation", at);
  if (explanation !== undefined) verdict.explanation = explanation;
  if (checked.confidence !== undefined) verdict.confidence = checked.confidence;
  const metadata = optionalObject(row, "metadata", at);
  if (metadata !== undefined) verdict.metadata = metadata;
  return verdict;
}

function toCaseReport(raw: unknown, where: string): CaseReport {
  if (!isObject(raw)) throw new Error(`${where}: expected an object`);
  const id = raw["id"];
  if (typeof id !== "string" || id === "") {
    throw new Error(`${where}: "id" must be a non-empty string`);
  }
  const scorers = optionalObject(raw, "scorers", where);
  if (scorers === undefined) throw new Error(`${where}: "scorers" must be an object`);
  const caseReport: CaseReport = {
    id,
    pass: bool(raw, "pass", where),
    score: finite(raw, "score", where),
    scorers: Object.fromEntries(
      Object.entries(scorers).map(([name, v]) => [name, toVerdict(name, v, where)]),
    ),
    latencyMs: finite(raw, "latencyMs", where),
  };
  const error = optionalString(raw, "error", where);
  if (error !== undefined) caseReport.error = error;
  return caseReport;
}

/** Parses `toJson` output. Throws on a missing or unknown `format` and on a malformed report. */
export function parseReport(text: string, source = "report"): EvalReport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${source}: invalid JSON (${(cause as Error).message})`);
  }
  if (!isObject(raw)) throw new Error(`${source}: expected an object`);
  if (raw["format"] === undefined) throw new Error(`${source}: missing "format"`);
  if (raw["format"] !== REPORT_FORMAT_VERSION) {
    throw new Error(
      `${source}: unknown format ${JSON.stringify(raw["format"])}, expected ${REPORT_FORMAT_VERSION}`,
    );
  }
  const name = raw["eval"];
  if (typeof name !== "string" || name === "") {
    throw new Error(`${source}: "eval" must be a non-empty string`);
  }
  const startedAt = raw["startedAt"];
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) {
    throw new Error(`${source}: "startedAt" must be an ISO time`);
  }
  if (!Array.isArray(raw["cases"])) throw new Error(`${source}: "cases" must be an array`);
  const ids = new Set<string>();
  const cases = raw["cases"].map((caseReport: unknown, i) => {
    const parsed = toCaseReport(caseReport, `${source}: cases[${i}]`);
    if (ids.has(parsed.id)) throw new Error(`${source}: duplicate case id "${parsed.id}"`);
    ids.add(parsed.id);
    return parsed;
  });
  const report: EvalReport = {
    eval: name,
    startedAt,
    total: finite(raw, "total", source),
    passed: finite(raw, "passed", source),
    passRate: finite(raw, "passRate", source),
    avgScore: finite(raw, "avgScore", source),
    thresholdsMet: bool(raw, "thresholdsMet", source),
    cases,
  };
  const metadata = optionalObject(raw, "metadata", source);
  if (metadata !== undefined) report.metadata = metadata;
  return report;
}

export async function fromJsonReport(path: string): Promise<EvalReport> {
  return parseReport(await Bun.file(path).text(), path);
}

export type ReportDiff = {
  eval: string;
  passRateDelta: number;
  avgScoreDelta: number;
  /** Passed before, fails now. */
  regressed: string[];
  /** Failed before, passes now. */
  fixed: string[];
  /** Cases present in both runs whose score moved. */
  changed: { id: string; before: number; after: number }[];
  added: string[];
  removed: string[];
};

/** Throws when the reports come from different evals. */
export function diffReports(before: EvalReport, after: EvalReport): ReportDiff {
  if (before.eval !== after.eval) {
    throw new Error(`diffReports: cannot compare eval "${before.eval}" with "${after.eval}"`);
  }
  const prev = new Map(before.cases.map((c) => [c.id, c]));
  const next = new Map(after.cases.map((c) => [c.id, c]));
  const diff: ReportDiff = {
    eval: after.eval,
    passRateDelta: after.passRate - before.passRate,
    avgScoreDelta: after.avgScore - before.avgScore,
    regressed: [],
    fixed: [],
    changed: [],
    added: [],
    removed: [],
  };
  for (const [id, a] of next) {
    const b = prev.get(id);
    if (b === undefined) {
      diff.added.push(id);
      continue;
    }
    if (b.pass && !a.pass) diff.regressed.push(id);
    if (!b.pass && a.pass) diff.fixed.push(id);
    if (b.score !== a.score) diff.changed.push({ id, before: b.score, after: a.score });
  }
  for (const id of prev.keys()) if (!next.has(id)) diff.removed.push(id);
  return diff;
}
