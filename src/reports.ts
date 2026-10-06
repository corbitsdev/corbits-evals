import { describe } from "./results.js";
import type { CaseReport, EvalReport } from "./types.js";

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

function scorerSummary(kase: CaseReport): string {
  return Object.entries(kase.scorers)
    .map(([name, v]) => `${name}=${v.label ?? describe(v.result)}${v.pass ? "" : " ✗"}`)
    .join(", ");
}

function failureDetail(kase: CaseReport): string {
  const lines = Object.entries(kase.scorers)
    .filter(([, v]) => !v.pass)
    .map(([name, v]) => `${name}: ${v.explanation ?? `score ${v.score.toFixed(3)}`}`);
  return lines.length === 0 ? `score ${kase.score.toFixed(3)}` : lines.join("\n");
}

/** One-line markdown summary plus per-case table. */
export function toMarkdown(report: EvalReport): string {
  const lines = [
    `# eval: ${cell(report.eval)}`,
    ``,
    `- cases: ${report.total}, passed: ${report.passed} (${(report.passRate * 100).toFixed(1)}%)`,
    `- avg score: ${report.avgScore.toFixed(3)}`,
    `- thresholds: ${report.thresholdsMet ? "met" : "NOT met"}`,
    ``,
    `| case | pass | score | detail |`,
    `| ---- | ---- | ----- | ------ |`,
  ];
  for (const kase of report.cases) {
    const detail = kase.error === undefined ? scorerSummary(kase) : `error: ${kase.error}`;
    lines.push(
      `| ${cell(kase.id)} | ${kase.pass ? "yes" : "no"} | ${kase.score.toFixed(3)} | ${cell(detail)} |`,
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
  const cases = report.cases.map((kase) => {
    let body = "";
    if (kase.error !== undefined) {
      body = `    <error message="task error">${esc(kase.error)}</error>\n`;
    } else if (!kase.pass) {
      body = `    <failure message="case failed">${esc(failureDetail(kase))}</failure>\n`;
    }
    return `  <testcase classname="${esc(report.eval)}" name="${esc(kase.id)}" time="${(kase.latencyMs / 1000).toFixed(3)}">\n${body}  </testcase>`;
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

/** Stable JSON for storage. Store it wherever you like and diff later with `diffReports`. */
export function toJson(report: EvalReport): string {
  return JSON.stringify({ format: REPORT_FORMAT_VERSION, ...report }, null, 2);
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

export function diffReports(before: EvalReport, after: EvalReport): ReportDiff {
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
