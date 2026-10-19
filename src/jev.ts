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
  /** Replaces `fetch` and the scheduler, e.g. to stub Jev in tests. */
  deps?: EvaluateDeps;
};

export type Judge = { readonly config: EvaluateConfig; readonly deps?: EvaluateDeps };

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
  return options.deps === undefined ? { config } : { config, deps: options.deps };
}

/** A Jev question with named answers. A plain string check is the yes/no case. */
export type Ask = {
  readonly question: string;
  readonly options?: Readonly<Record<string, string>>;
  readonly levels?: readonly string[];
  readonly pass: readonly string[];
};

/** Pick one option; pass when Jev picks one of `pass`. */
export function ask(
  question: string,
  spec: { options: Readonly<Record<string, string>>; pass: string | readonly string[] },
): Ask;
/** Grade on ordered levels, lowest first; pass at `pass` or above. */
export function ask(question: string, spec: { levels: readonly string[]; pass: string }): Ask;
export function ask(
  question: string,
  spec: {
    options?: Readonly<Record<string, string>>;
    levels?: readonly string[];
    pass: string | readonly string[];
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
  return spec.options === undefined
    ? { question, levels: names, pass }
    : { question, options: spec.options, pass };
}

/** Yes/no passes at p >= YES, fails at p <= NO; between is unsure and fails. */
const YES = 0.7;
const NO = 0.3;
/** A choice or level picked with less probability than this is unsure and fails. */
const SURE = 0.6;

function toQuestion(id: string, check: Ask | string): Question {
  if (typeof check === "string") return { id, type: "boolean", instructions: check };
  if (check.options !== undefined) {
    return {
      id,
      type: "choice",
      instructions: check.question,
      criteria: { ...check.options },
    };
  }
  return {
    id,
    type: "score",
    instructions: check.question,
    criteria: [...(check.levels ?? [])],
  };
}

function failed(explanation: string): Outcome {
  return { pass: false, value: 0, explanation };
}

function p(n: number): string {
  return n.toFixed(2);
}

function toOutcome(check: Ask | string, decision: Decision): Outcome {
  if (decision.type === "noul") {
    const yes = decision.noul;
    if (yes >= YES) return { pass: true, value: yes, label: "yes" };
    if (yes <= NO) return { pass: false, value: yes, label: "no", explanation: `no (p=${p(yes)})` };
    return { pass: false, value: yes, label: "unsure", explanation: `unsure (p=${p(yes)})` };
  }
  const ask = check as Ask;
  const top = Math.max(...Object.values(decision.probabilities));
  if (decision.type === "choice") {
    const value = Math.min(
      1,
      ask.pass.reduce((t, name) => t + (decision.probabilities[name] ?? 0), 0),
    );
    if (top < SURE) {
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
  if (top < SURE) return { ...failed(`unsure (p=${p(top)} for "${level}")`), value, label: level };
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
  checks: Record<string, Ask | string>,
  run: Run,
): Promise<Record<string, Outcome>> {
  const names = Object.keys(checks);
  const state: Record<string, unknown> = { input: run.input, output: run.output };
  if (run.expect !== undefined) state["expect"] = run.expect;
  if (run.steps.length > 0) state["steps"] = run.steps;
  const questions = names.map((id) => toQuestion(id, checks[id] as Ask | string));
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
          : toOutcome(checks[name] as Ask | string, decision);
      return [name, outcome];
    }),
  );
}

function failedAll(names: readonly string[], explanation: string): Record<string, Outcome> {
  return Object.fromEntries(names.map((name) => [name, failed(explanation)]));
}
