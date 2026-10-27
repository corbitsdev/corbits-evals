import type { Decision, Question } from "@corbits/system-one";

import type { Outcome, Run } from "./types.js";

export type JevOptions = {
  /** Pass bars for every Jev check through this judge. */
  thresholds?: Thresholds;
  /** Consulted when a decision lands unsure. `sure` doubles as the escalation gate. */
  escalate?: Escalation;
};

/** Yes/no passes at p >= `yes` and fails at p <= `no`; `ask` is unsure under `sure`. */
export type Thresholds = { yes?: number; no?: number; sure?: number };

export type Resolved = { yes: number; no: number; sure: number };

/** The one documented set of numbers, tuned per workload with `calibrate`. */
export const DEFAULTS: Resolved = { yes: 0.7, no: 0.3, sure: 0.6 };

/** What one judge call sends. Questions are id-keyed; boolean checks are `noul`. */
export type JudgePayload = {
  readonly state: Record<string, unknown>;
  readonly questions: Readonly<
    Record<string, { type: string; instructions: Question["instructions"]; criteria?: unknown }>
  >;
};

export type Judge = {
  readonly thresholds?: Resolved;
  readonly escalate?: Escalation;
  /**
   * One call per case attempt. `judgeModel` sets this; `systemOne()` alone does not,
   * so it is not a model.
   * Resolves to `{ decisions }` or `{ fallback: true, reason, detail? }`.
   */
  readonly invoke?: (payload: JudgePayload) => Promise<unknown>;
};

/**
 * An agent consulted when the primary Jev decision lands unsure — e.g. an
 * `@intx/agent` agent from a `@corbits/*` adapter. It gets the same question
 * with the exact answer space; its reply must stay inside that space.
 */
export type Escalation = {
  readonly send: (
    content: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<{ type: "reply"; reply: string } | { type: "suspended" }>;
};

function resolve(label: string, raw: Thresholds): Resolved {
  const out: Resolved = {
    yes: raw.yes ?? DEFAULTS.yes,
    no: raw.no ?? DEFAULTS.no,
    sure: raw.sure ?? DEFAULTS.sure,
  };
  for (const [key, value] of Object.entries(out)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`jev: ${label}.${key} must be in [0, 1]`);
    }
  }
  if (out.no > out.yes) throw new Error(`jev: ${label}.no must not exceed ${label}.yes`);
  return out;
}

/** Thresholds and an optional escalation agent. Not a model and not an HTTP client. */
export function systemOne(options: JevOptions = {}): Judge {
  const thresholds =
    options.thresholds === undefined ? undefined : resolve("thresholds", options.thresholds);
  return {
    ...(thresholds === undefined ? {} : { thresholds }),
    ...(options.escalate === undefined ? {} : { escalate: options.escalate }),
  };
}

/** Same function as `systemOne`. */
export { systemOne as jev };

/** A Jev question with named answers. A plain string check is the yes/no case. */
export type Ask = {
  readonly question: string;
  /** Descriptions (pass-set form) or credits in 0..1 (credit form). */
  readonly options?: Readonly<Record<string, string | number>>;
  readonly levels?: readonly string[];
  /** Pass-set form: Jev must pick one of these. */
  readonly pass?: readonly string[];
  /** Credit form: the picked option's credit must reach this (default 1). */
  readonly passAt?: number;
  /** Overrides the judge's `sure` bar. */
  readonly sure?: number;
};

/** A yes/no question with its own pass bars. A plain string uses the judge's. */
export type Sentence = {
  readonly question: string;
  readonly yes?: number;
  readonly no?: number;
};

/** Pick one option; pass when Jev picks one of `pass`. */
export function ask(
  question: string,
  spec: {
    options: Readonly<Record<string, string>>;
    pass: string | readonly string[];
    sure?: number;
  },
): Ask;
/** Pick one option; pass when the picked option's credit reaches `passAt`. */
export function ask(
  question: string,
  spec: { options: Readonly<Record<string, number>>; passAt?: number; sure?: number },
): Ask;
/** Grade on ordered levels, lowest first; pass at `pass` or above. */
export function ask(
  question: string,
  spec: { levels: readonly string[]; pass: string; sure?: number },
): Ask;
export function ask(
  question: string,
  spec: {
    options?: Readonly<Record<string, string | number>>;
    levels?: readonly string[];
    pass?: string | readonly string[];
    passAt?: number;
    sure?: number;
  },
): Ask {
  if (question.trim() === "") throw new Error("ask needs a question");
  if (spec.sure !== undefined && (!Number.isFinite(spec.sure) || spec.sure <= 0 || spec.sure > 1)) {
    throw new Error("ask: sure must be in (0, 1]");
  }
  const sure = spec.sure === undefined ? {} : { sure: spec.sure };
  const levels = spec.levels;
  if (spec.options === undefined) {
    if (levels === undefined) throw new Error("ask needs options or levels");
    if (levels.length < 2 || levels.length > 10) {
      throw new Error("ask: levels must have 2 to 10 entries");
    }
    if (spec.passAt !== undefined) throw new Error("ask: passAt needs credit options");
    const pass = typeof spec.pass === "string" ? [spec.pass] : spec.pass;
    if (pass === undefined || pass.length === 0) throw new Error("ask: pass names no answer");
    for (const name of pass) {
      if (!levels.includes(name)) throw new Error(`ask: pass "${name}" is not an answer`);
    }
    return { question, levels, pass, ...sure };
  }
  const entries = Object.entries(spec.options);
  if (entries.length === 0) throw new Error("ask: options must not be empty");
  const credits = entries.every(([, v]) => typeof v === "number");
  if (!credits && !entries.every(([, v]) => typeof v === "string")) {
    throw new Error("ask: options must be all descriptions or all credits");
  }
  if (credits) {
    if (spec.pass !== undefined) throw new Error("ask: credit options pass by passAt, not pass");
    const passAt = spec.passAt ?? 1;
    if (!Number.isFinite(passAt) || passAt <= 0 || passAt > 1) {
      throw new Error("ask: passAt must be in (0, 1]");
    }
    for (const [name, credit] of entries) {
      if (typeof credit !== "number" || !Number.isFinite(credit) || credit < 0 || credit > 1) {
        throw new Error(`ask: credit "${name}" must be in [0, 1]`);
      }
    }
    return { question, options: { ...spec.options }, passAt, ...sure };
  }
  if (spec.passAt !== undefined) throw new Error("ask: passAt needs credit options");
  const pass = typeof spec.pass === "string" ? [spec.pass] : spec.pass;
  if (pass === undefined || pass.length === 0) throw new Error("ask: pass names no answer");
  for (const name of pass) {
    if (!(name in spec.options)) throw new Error(`ask: pass "${name}" is not an answer`);
  }
  return { question, options: { ...spec.options }, pass, ...sure };
}

function toQuestion(id: string, check: Ask | Sentence | string): Question {
  if (typeof check === "string") return { id, type: "boolean", instructions: check };
  if ("options" in check && check.options !== undefined) {
    return {
      id,
      type: "choice",
      instructions: check.question,
      criteria: Object.fromEntries(
        Object.entries(check.options).map(([name, v]) => [name, typeof v === "number" ? name : v]),
      ),
    };
  }
  if ("levels" in check && check.levels !== undefined) {
    return {
      id,
      type: "score",
      instructions: check.question,
      criteria: [...check.levels],
    };
  }
  return { id, type: "boolean", instructions: check.question };
}

function failed(explanation: string): Outcome {
  return { pass: false, value: 0, explanation };
}

function p(n: number): string {
  return n.toFixed(2);
}

/** Per-check overrides win over the judge's, which win over `DEFAULTS`. */
function thresholdsFor(check: Ask | Sentence | string, judge: Judge): Resolved {
  const base = judge.thresholds ?? DEFAULTS;
  if (typeof check === "string") return base;
  const any = check as { sure?: number; yes?: number; no?: number };
  const yes = any.yes ?? base.yes;
  return {
    yes,
    // A check-level `no` above the merged `yes` would overlap the pass band.
    // Clamping it keeps the band shape; the pass branch already wins the
    // overlap, so no verdict changes.
    no: Math.min(any.no ?? base.no, yes),
    sure: any.sure ?? base.sure,
  };
}

/** Throws when a per-check override is malformed, so bad bars fail at definition. */
export function checkThresholds(check: Ask | Sentence | string): void {
  if (typeof check === "string") return;
  const any = check as { sure?: number; yes?: number; no?: number };
  for (const key of ["yes", "no"] as const) {
    const value = any[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`jev: ${key} must be in [0, 1]`);
    }
  }
  const sure = any.sure;
  if (sure !== undefined && (!Number.isFinite(sure) || sure <= 0 || sure > 1)) {
    throw new Error("jev: sure must be in (0, 1]");
  }
  if (any.yes !== undefined && any.no !== undefined && any.no > any.yes) {
    throw new Error("jev: no must not exceed yes");
  }
}

/** The decision's full distribution; the answer never carries it alone. */
function dist(decision: Exclude<Decision, { type: "box" }>): {
  probabilities: Record<string, number>;
  confidence?: number;
} {
  if (decision.type === "noul") {
    const yes = r3(decision.noul);
    return { probabilities: { yes, no: r3(1 - decision.noul) } };
  }
  return { probabilities: { ...decision.probabilities }, confidence: decision.confidence };
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function toOutcome(
  check: Ask | Sentence | string,
  decision: Decision,
  judge: Judge,
): Outcome {
  // A box locates a region. It has no distribution and is not a yes/no, choice, or score.
  if (decision.type === "box") return failed("jev returned a box decision");
  const t = thresholdsFor(check, judge);
  const d = dist(decision);
  if (decision.type === "noul") {
    const yes = decision.noul;
    if (yes >= t.yes) return { pass: true, value: yes, label: "yes", ...d };
    if (yes <= t.no)
      return { pass: false, value: yes, label: "no", explanation: `no (p=${p(yes)})`, ...d };
    return { pass: false, value: yes, label: "unsure", explanation: `unsure (p=${p(yes)})`, ...d };
  }
  const ask = check as Ask;
  const top = Math.max(...Object.values(decision.probabilities));
  if (decision.type === "choice") {
    const raw = ask.options?.[decision.choice];
    const credit = typeof raw === "number" ? raw : undefined;
    const value =
      credit ??
      Math.min(
        1,
        (ask.pass ?? []).reduce((sum, name) => sum + (decision.probabilities[name] ?? 0), 0),
      );
    if (top < t.sure) {
      return {
        ...failed(`unsure (p=${p(top)} for "${decision.choice}")`),
        value,
        label: decision.choice,
        ...d,
      };
    }
    const pass =
      credit !== undefined
        ? credit >= (ask.passAt ?? 1)
        : (ask.pass?.includes(decision.choice) ?? false);
    const outcome: Outcome = { pass, value, label: decision.choice, ...d };
    if (!pass) {
      outcome.explanation =
        credit === undefined
          ? `picked "${decision.choice}"`
          : `picked "${decision.choice}" (credit ${p(credit)})`;
    }
    return outcome;
  }
  const levels = ask.levels ?? [];
  const index = Math.round(decision.score);
  const level = levels[index] ?? String(decision.score);
  const value = decision.score / (levels.length - 1);
  if (top < t.sure)
    return { ...failed(`unsure (p=${p(top)} for "${level}")`), value, label: level, ...d };
  const pass = index >= levels.indexOf(ask.pass?.[0] ?? "");
  const outcome: Outcome = { pass, value, label: level, ...d };
  if (!pass) outcome.explanation = `graded "${level}"`;
  return outcome;
}

function toState(run: Run): Record<string, unknown> {
  const state: Record<string, unknown> = { input: run.input, output: run.output };
  if (run.expectedOutput !== undefined) state["expectedOutput"] = run.expectedOutput;
  if (run.steps.length > 0) state["steps"] = run.steps;
  return state;
}

function wireQuestions(questions: readonly Question[]): JudgePayload["questions"] {
  const wire: Record<
    string,
    { type: string; instructions: Question["instructions"]; criteria?: unknown }
  > = {};
  for (const question of questions) {
    const mapped: { type: string; instructions: Question["instructions"]; criteria?: unknown } = {
      type: question.type === "boolean" ? "noul" : question.type,
      instructions: question.instructions,
    };
    if ("criteria" in question && question.criteria !== undefined)
      mapped.criteria = question.criteria;
    wire[question.id] = mapped;
  }
  return wire;
}

type JudgeReply = { fallback: true; reason: string; detail?: string } | { decisions: Decision[] };

function readReply(out: unknown): JudgeReply | undefined {
  if (typeof out !== "object" || out === null) return undefined;
  const record = out as Record<string, unknown>;
  if (record["fallback"] === true) {
    const reason = typeof record["reason"] === "string" ? record["reason"] : "parse-error";
    const detail = typeof record["detail"] === "string" ? record["detail"] : undefined;
    return { fallback: true, reason, ...(detail === undefined ? {} : { detail }) };
  }
  if (Array.isArray(record["decisions"])) return { decisions: record["decisions"] as Decision[] };
  return undefined;
}

/** Fail closed: a thrown invoke is a transport fallback, same as a typed one. */
async function callJudge(judge: Judge, questions: Question[], run: Run): Promise<JudgeReply> {
  if (judge.invoke === undefined) throw new Error("jev: judge has no invoke");
  let out: unknown;
  try {
    out = await judge.invoke({ state: toState(run), questions: wireQuestions(questions) });
  } catch (cause) {
    return {
      fallback: true,
      reason: "network",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return (
    readReply(out) ?? {
      fallback: true,
      reason: "parse-error",
      detail: "judge output was not decisions or a fallback",
    }
  );
}

/**
 * Answer every check in one Jev call, keyed by check name. Fail-closed:
 * transport fallbacks, thrown errors and missing decisions all fail — a
 * transport failure fails every check in the batch, a missing decision
 * fails only its own.
 */
export async function askJevBatch(
  judge: Judge,
  checks: Record<string, Ask | Sentence | string>,
  run: Run,
): Promise<Record<string, Outcome>> {
  const names = Object.keys(checks);
  const questions = names.map((id) => toQuestion(id, checks[id] as Ask | Sentence | string));
  let out: JudgeReply;
  try {
    out = await callJudge(judge, questions, run);
  } catch (cause) {
    return failedAll(names, `jev threw: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if ("fallback" in out) {
    return failedAll(names, `jev fallback (${out.reason}): ${out.detail ?? "no detail"}`);
  }
  const decisions = new Map(out.decisions.map((decision) => [decision.id, decision]));
  const entries = await Promise.all(
    names.map(async (name) => {
      const decision = decisions.get(name);
      const check = checks[name] as Ask | Sentence | string;
      const outcome =
        decision === undefined
          ? failed("jev returned no decision")
          : toOutcome(check, decision, judge);
      if (judge.escalate !== undefined && isUnsure(outcome)) {
        return [name, await escalateUnsure(judge, check, run)] as const;
      }
      return [name, outcome] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * One Jev call returning raw decisions keyed by check name. Throws on a
 * transport failure — for callers like `calibrate` that want loud errors
 * instead of fail-closed outcomes.
 */
export async function decideBatch(
  judge: Judge,
  checks: Record<string, Ask | Sentence | string>,
  run: Run,
): Promise<Record<string, Decision>> {
  const names = Object.keys(checks);
  const out = await callJudge(
    judge,
    names.map((id) => toQuestion(id, checks[id] as Ask | Sentence | string)),
    run,
  );
  if ("fallback" in out)
    throw new Error(`jev fallback (${out.reason}): ${out.detail ?? "no detail"}`);
  return Object.fromEntries(out.decisions.map((decision) => [decision.id, decision]));
}

function failedAll(names: readonly string[], explanation: string): Record<string, Outcome> {
  return Object.fromEntries(names.map((name) => [name, failed(explanation)]));
}

/** Unsure outcomes are exactly the failed ones whose explanation starts "unsure (". */
function isUnsure(outcome: Outcome): boolean {
  return !outcome.pass && (outcome.explanation?.startsWith("unsure (") ?? false);
}

function allowedAnswers(check: Ask | Sentence | string): string[] {
  if (typeof check === "string" || "yes" in check) return ["yes", "no"];
  const a = check as Ask;
  if (a.levels !== undefined) return [...a.levels];
  if (a.options !== undefined) return Object.keys(a.options);
  return [...(a.pass ?? [])];
}

function escalationPrompt(check: Ask | Sentence | string, run: Run, answers: string[]): string {
  const question = typeof check === "string" ? check : check.question;
  return [
    "A primary judge could not decide the following case confidently. Decide it.",
    `Question: ${question}`,
    `Reply with exactly one of: ${answers.map((answer) => `"${answer}"`).join(", ")}.`,
    `Case: ${JSON.stringify(toState(run))}`,
  ].join("\n\n");
}

/**
 * Longest match wins, so overlapping names resolve to the more specific one.
 * Boundary assertions apply only at word-character edges: `\b` sits between
 * two non-word characters where no boundary exists, so answers like "@done"
 * or "50%" would otherwise never match an exact reply.
 */
function pickAnswer(reply: string, answers: string[]): string | undefined {
  const escaped = (answer: string) => answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const edge = (answer: string, at: "head" | "tail") => {
    const c = at === "head" ? answer.charAt(0) : answer.charAt(answer.length - 1);
    return /[A-Za-z0-9_]/.test(c) ? "\\b" : "";
  };
  for (const answer of [...answers].sort((a, b) => b.length - a.length)) {
    const pattern = `${edge(answer, "head")}${escaped(answer)}${edge(answer, "tail")}`;
    if (new RegExp(pattern, "i").test(reply)) return answer;
  }
  return undefined;
}

/** The escalated answer as a Decision, so `toOutcome`'s own rules apply. */
function escalatedDecision(check: Ask | Sentence | string, picked: string): Decision {
  if (typeof check === "string" || "yes" in check)
    return { id: "escalated", type: "noul", noul: picked.toLowerCase() === "yes" ? 1 : 0 };
  const a = check as Ask;
  if (a.levels !== undefined)
    return {
      id: "escalated",
      type: "score",
      score: a.levels.indexOf(picked),
      legend: Object.fromEntries(a.levels.map((level) => [level, level])),
      probabilities: { [picked]: 1 },
      confidence: 1,
    };
  return {
    id: "escalated",
    type: "choice",
    choice: picked,
    probabilities: { [picked]: 1 },
    confidence: 1,
  };
}

/**
 * Consult `judge.escalate` for an unsure decision. The reply goes through the
 * same pass rules as a primary decision, minus the confidence gate; a thrown,
 * suspended, or off-space reply fails the case closed.
 */
async function escalateUnsure(
  judge: Judge,
  check: Ask | Sentence | string,
  run: Run,
): Promise<Outcome> {
  const escalation = judge.escalate as Escalation;
  let reply: string;
  try {
    const result = await escalation.send(escalationPrompt(check, run, allowedAnswers(check)));
    if (result.type !== "reply") return failed(`unsure, and escalation did not reply`);
    reply = result.reply;
  } catch (cause) {
    return failed(
      `unsure, and escalation threw: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const picked = pickAnswer(reply, allowedAnswers(check));
  if (picked === undefined)
    return failed(
      `unsure, and escalation replied outside the answer space ("${reply.trim().slice(0, 40)}")`,
    );
  const outcome = toOutcome(check, escalatedDecision(check, picked), judge);
  delete outcome.probabilities;
  delete outcome.confidence;
  const raw = (check as Ask).options?.[picked];
  const credit = typeof raw === "number" ? raw : undefined;
  outcome.explanation = `escalated to "${picked}"${credit === undefined ? "" : ` (credit ${p(credit)})`}`;
  return outcome;
}
