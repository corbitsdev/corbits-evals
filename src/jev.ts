import {
  evaluate,
  type Decision,
  type EndpointConfig,
  type EvaluateConfig,
  type EvaluateDeps,
  type Question,
} from "@corbits/system-one";

import { toMs, type Duration } from "./timeout.js";
import type { Outcome, Run } from "./types.js";

export type JevOptions = {
  /** "official" (default), "gateway", or the URL of a custom endpoint. */
  endpoint?: string;
  model?: string;
  /** Defaults to the endpoint's environment key, as `@corbits/system-one` reads it. */
  apiKey?: string;
  /** Bounds one Jev call. `@corbits/system-one` defaults to 1500ms. */
  timeout?: Duration;
  /** Pass bars for every Jev check through this judge. */
  thresholds?: Thresholds;
  /** Replaces `fetch` and the scheduler, e.g. to stub Jev in tests. */
  deps?: EvaluateDeps;
};

/** Yes/no passes at p >= `yes` and fails at p <= `no`; `ask` is unsure under `sure`. */
export type Thresholds = { yes?: number; no?: number; sure?: number };

export type Resolved = { yes: number; no: number; sure: number };

/** The one documented set of numbers, tuned per workload with `calibrate`. */
export const DEFAULTS: Resolved = { yes: 0.7, no: 0.3, sure: 0.6 };

export type Judge = {
  readonly config: EvaluateConfig;
  readonly thresholds?: Resolved;
  readonly deps?: EvaluateDeps;
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

function toEndpoint(endpoint?: string, model?: string): EndpointConfig | undefined {
  const named = model === undefined ? {} : { model };
  if (endpoint === undefined)
    return model === undefined ? undefined : { kind: "official", ...named };
  if (endpoint === "official" || endpoint === "gateway") return { kind: endpoint, ...named };
  return { kind: "custom", url: endpoint, ...named };
}

export function jev(options: JevOptions = {}): Judge {
  const config: EvaluateConfig = {};
  const endpoint = toEndpoint(options.endpoint, options.model);
  if (endpoint !== undefined) config.endpoint = endpoint;
  if (options.apiKey !== undefined) config.apiKey = options.apiKey;
  if (options.timeout !== undefined) config.timeoutMs = toMs(options.timeout, "jev timeout");
  const thresholds =
    options.thresholds === undefined ? undefined : resolve("thresholds", options.thresholds);
  return {
    config,
    ...(thresholds === undefined ? {} : { thresholds }),
    ...(options.deps === undefined ? {} : { deps: options.deps }),
  };
}

/** A Jev question with named answers. A plain string check is the yes/no case. */
export type Ask = {
  readonly question: string;
  readonly options?: Readonly<Record<string, string>>;
  readonly levels?: readonly string[];
  readonly pass: readonly string[];
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
/** Grade on ordered levels, lowest first; pass at `pass` or above. */
export function ask(
  question: string,
  spec: { levels: readonly string[]; pass: string; sure?: number },
): Ask;
export function ask(
  question: string,
  spec: {
    options?: Readonly<Record<string, string>>;
    levels?: readonly string[];
    pass: string | readonly string[];
    sure?: number;
  },
): Ask {
  if (question.trim() === "") throw new Error("ask needs a question");
  const pass = typeof spec.pass === "string" ? [spec.pass] : spec.pass;
  const names = spec.options === undefined ? spec.levels : Object.keys(spec.options);
  if (names === undefined) throw new Error("ask needs options or levels");
  if (spec.levels !== undefined && (spec.levels.length < 2 || spec.levels.length > 10)) {
    throw new Error("ask: levels must have 2 to 10 entries");
  }
  if (names.length === 0) throw new Error("ask: options must not be empty");
  if (pass.length === 0) throw new Error("ask: pass names no answer");
  for (const name of pass) {
    if (!names.includes(name)) throw new Error(`ask: pass "${name}" is not an answer`);
  }
  if (spec.sure !== undefined && (!Number.isFinite(spec.sure) || spec.sure <= 0 || spec.sure > 1)) {
    throw new Error("ask: sure must be in (0, 1]");
  }
  const sure = spec.sure === undefined ? {} : { sure: spec.sure };
  return spec.options === undefined
    ? { question, levels: names, pass, ...sure }
    : { question, options: spec.options, pass, ...sure };
}

function toQuestion(id: string, check: Ask | Sentence | string): Question {
  if (typeof check === "string") return { id, type: "boolean", instructions: check };
  if ("options" in check && check.options !== undefined) {
    return {
      id,
      type: "choice",
      instructions: check.question,
      criteria: { ...check.options },
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
  return {
    yes: any.yes ?? base.yes,
    no: any.no ?? base.no,
    sure: any.sure ?? base.sure,
  };
}

/** Throws when a per-check override is malformed, so bad bars fail at definition. */
export function checkThresholds(check: Ask | Sentence | string): void {
  if (typeof check === "string") return;
  const any = check as { sure?: number; yes?: number; no?: number };
  for (const key of ["yes", "no", "sure"] as const) {
    const value = any[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`jev: ${key} must be in [0, 1]`);
    }
  }
  if (any.yes !== undefined && any.no !== undefined && any.no > any.yes) {
    throw new Error("jev: no must not exceed yes");
  }
}

function toOutcome(check: Ask | Sentence | string, decision: Decision, judge: Judge): Outcome {
  const t = thresholdsFor(check, judge);
  if (decision.type === "noul") {
    const yes = decision.noul;
    if (yes >= t.yes) return { pass: true, value: yes, label: "yes" };
    if (yes <= t.no)
      return { pass: false, value: yes, label: "no", explanation: `no (p=${p(yes)})` };
    return { pass: false, value: yes, label: "unsure", explanation: `unsure (p=${p(yes)})` };
  }
  const ask = check as Ask;
  const top = Math.max(...Object.values(decision.probabilities));
  if (decision.type === "choice") {
    const value = Math.min(
      1,
      ask.pass.reduce((sum, name) => sum + (decision.probabilities[name] ?? 0), 0),
    );
    if (top < t.sure) {
      return {
        ...failed(`unsure (p=${p(top)} for "${decision.choice}")`),
        value,
        label: decision.choice,
      };
    }
    const pass = ask.pass.includes(decision.choice);
    const outcome: Outcome = { pass, value, label: decision.choice };
    if (!pass) outcome.explanation = `picked "${decision.choice}"`;
    return outcome;
  }
  const levels = ask.levels ?? [];
  const index = Math.round(decision.score);
  const level = levels[index] ?? String(decision.score);
  const value = decision.score / (levels.length - 1);
  if (top < t.sure)
    return { ...failed(`unsure (p=${p(top)} for "${level}")`), value, label: level };
  const pass = index >= levels.indexOf(ask.pass[0] ?? "");
  const outcome: Outcome = { pass, value, label: level };
  if (!pass) outcome.explanation = `graded "${level}"`;
  return outcome;
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
  const state: Record<string, unknown> = { input: run.input, output: run.output };
  if (run.expect !== undefined) state["expect"] = run.expect;
  if (run.steps.length > 0) state["steps"] = run.steps;
  const questions = names.map((id) => toQuestion(id, checks[id] as Ask | Sentence | string));
  let out;
  try {
    out = await evaluate(
      { state, questions, config: judge.config },
      judge.deps === undefined ? undefined : { deps: judge.deps },
    );
  } catch (cause) {
    return failedAll(names, `jev threw: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (out.fallback) {
    return failedAll(names, `jev fallback (${out.reason}): ${out.detail ?? "no detail"}`);
  }
  const decisions = new Map(out.decisions.map((decision) => [decision.id, decision]));
  return Object.fromEntries(
    names.map((name) => {
      const decision = decisions.get(name);
      const outcome =
        decision === undefined
          ? failed("jev returned no decision")
          : toOutcome(checks[name] as Ask | Sentence | string, decision, judge);
      return [name, outcome];
    }),
  );
}

function failedAll(names: readonly string[], explanation: string): Record<string, Outcome> {
  return Object.fromEntries(names.map((name) => [name, failed(explanation)]));
}
