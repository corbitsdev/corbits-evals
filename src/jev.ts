import {
  evaluate,
  type Decision,
  type EndpointConfig,
  type EvaluateDeps,
  type Question,
  type State,
} from "@corbits/system-one";

import { booleanResult, categoryResult, clamp01, normalize, scoreResult } from "./results.js";
import type { EvalCase, Result, Scorer, ScorerResult, TaskOutput } from "./types.js";

export type JevJudgeOptions<I = string, E = string> = {
  questions: Question[];
  /**
   * Partial credit for choice questions, keyed by question id then option
   * (factuality A:.4 B:.6 C:1 D:0 E:1). A graded choice becomes a score
   * result instead of a category.
   */
  scores?: Record<string, Record<string, number>>;
  state?: (evalCase: EvalCase<I, E>, result: TaskOutput) => unknown;
  apiKey?: string;
  timeoutMs?: number;
  deps?: EvaluateDeps;
  endpoint?: EndpointConfig;
};

export function defaultJevState<I, E>(
  evalCase: EvalCase<I, E>,
  result: TaskOutput,
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    input: evalCase.input,
    output: result.output,
  };
  if (evalCase.expected !== undefined) state["expected"] = evalCase.expected;
  if (result.trajectory !== undefined) state["trajectory"] = result.trajectory;
  if (evalCase.metadata !== undefined) state["context"] = evalCase.metadata;
  return state;
}

/** Misconfiguration must fail at definition time, not as a permanently red eval. */
function validateOptions(questions: readonly Question[], scores: JevJudgeOptions["scores"]) {
  if (questions.length === 0) throw new Error("jevJudge needs at least one question");
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const [id, grades] of Object.entries(scores ?? {})) {
    const q = byId.get(id);
    if (q === undefined) throw new Error(`jevJudge: scores for "${id}" match no question`);
    if (q.type !== "choice")
      throw new Error(`jevJudge: scores only apply to choice questions ("${id}")`);
    const options = new Set(Object.keys(q.criteria));
    for (const option of Object.keys(grades)) {
      if (!options.has(option))
        throw new Error(`jevJudge: question "${id}" has no option "${option}"`);
    }
  }
}

function decisionToResult(
  decision: Decision,
  question: Question | undefined,
  grades: Record<string, number> | undefined,
): ScorerResult {
  if (decision.type === "choice") {
    const graded = grades?.[decision.choice];
    const scale = question?.type === "choice" ? Object.keys(question.criteria) : undefined;
    return {
      result:
        graded === undefined
          ? categoryResult(decision.choice, scale)
          : scoreResult(clamp01(graded)),
      label: decision.choice,
      confidence: decision.confidence,
      metadata: { probabilities: decision.probabilities },
    };
  }
  if (decision.type === "score") {
    const levels = Object.keys(decision.legend).length;
    return {
      result: scoreResult(levels <= 1 ? 0 : decision.score / (levels - 1)),
      label: String(decision.score),
      confidence: decision.confidence,
      metadata: { probabilities: decision.probabilities },
    };
  }
  const yes = decision.noul >= 0.5;
  return {
    result: booleanResult(yes),
    label: yes ? "true" : "false",
    confidence: yes ? decision.noul : 1 - decision.noul,
    metadata: { pTrue: decision.noul },
  };
}

function failed(explanation: string, metadata?: Record<string, unknown>): ScorerResult {
  const result: ScorerResult = { result: scoreResult(0), explanation };
  if (metadata !== undefined) result.metadata = metadata;
  return result;
}

/**
 * One POST per call because Jev answers independent questions in
 * parallel. One question yields its result directly (category, score or
 * boolean); several yield the mean of their normalized results as a
 * score, with each decision under `metadata.per`. Fail-closed: transport
 * fallbacks, thrown errors and empty decision sets all return score 0.
 */
export function jevJudge<I = string, E = string>(options: JevJudgeOptions<I, E>): Scorer<I, E> {
  validateOptions(options.questions, options.scores);
  const byId = new Map(options.questions.map((q) => [q.id, q]));
  const buildState = options.state ?? defaultJevState<I, E>;
  return async ({ evalCase, result }) => {
    let out;
    try {
      out = await evaluate(
        {
          state: buildState(evalCase, result) as State,
          questions: options.questions,
          ...(options.apiKey !== undefined ||
          options.timeoutMs !== undefined ||
          options.endpoint !== undefined
            ? {
                config: {
                  ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
                  ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
                  ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
                },
              }
            : {}),
        },
        options.deps !== undefined ? { deps: options.deps } : undefined,
      );
    } catch (cause) {
      return failed(`jev threw: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (out.fallback) {
      return failed(`jev fallback (${out.reason}): ${out.detail ?? "no detail"}`, {
        reason: out.reason,
      });
    }
    if (out.decisions.length === 0) return failed("jev returned no decisions");
    const per = out.decisions.map((d) =>
      decisionToResult(d, byId.get(d.id), options.scores?.[d.id]),
    );
    const only = per[0];
    if (per.length === 1 && only !== undefined) {
      return { ...only, metadata: { ...only.metadata, modelId: out.modelId } };
    }
    const values = per.map((r) => normalize(r.result, false));
    const confidences = per.map((r) => r.confidence).filter((c): c is number => c !== undefined);
    const compiled: ScorerResult = {
      result: scoreResult(values.reduce((t, v) => t + v, 0) / values.length),
      explanation: per.map((r, i) => `${out.decisions[i]?.id ?? i}=${r.label ?? "?"}`).join(", "),
      metadata: {
        modelId: out.modelId,
        per: Object.fromEntries(out.decisions.map((d, i) => [d.id, per[i]])),
      },
    };
    if (confidences.length > 0) {
      compiled.confidence = confidences.reduce((t, c) => t + c, 0) / confidences.length;
    }
    return compiled;
  };
}

export type { Decision, EndpointConfig, Question, Result };
