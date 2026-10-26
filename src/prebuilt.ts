import { defineAgent } from "@intx/agent";
import { defineWorkflow, step, type WorkflowDefinition } from "@intx/workflow";

import type { Outcome, Run, Step } from "./types.js";

/** Pinned inference source for a prebuilt judge. Both fields are required. */
export type ModelSource = { provider: string; model: string };

export type PrebuiltId = "faithfulness" | "answerRelevancy" | "correctness" | "trajectoryAccuracy";

/**
 * A one-step judge definition plus the payload for its trigger and the
 * outcome used when the run cannot be judged. This does not call a model.
 */
export type Prebuilt<P> = {
  id: PrebuiltId;
  definition: WorkflowDefinition;
  payload: (run: Run) => P | Outcome;
  failure: Outcome;
};

const CLOSED: Outcome = {
  pass: false,
  value: 0,
  explanation: "judge output failed closed",
};

const FAITH = ["contradicted", "unverifiable", "supported"] as const;
const CORRECT = ["incorrect", "partial", "correct"] as const;

const RUBRIC = {
  faithfulness: [
    "You judge whether every claim in the answer is faithful to the context.",
    "Reply with one JSON object and nothing else. No prose. No markdown fences.",
    '{"category":"contradicted"|"unverifiable"|"supported","explanation":"..."}',
    "Order, lowest first: contradicted, unverifiable, supported.",
    "contradicted: the answer conflicts with the context.",
    "unverifiable: the answer adds claims the context neither supports nor contradicts.",
    "supported: every claim in the answer is supported by the context.",
    "Pick the lowest category that applies.",
  ].join("\n"),
  answerRelevancy: [
    "You judge how completely the answer addresses the question.",
    "Reply with one JSON object and nothing else. No prose. No markdown fences.",
    '{"score":0,"explanation":"..."}',
    "score is a finite number from 0 to 1. 1 means the answer is fully relevant.",
  ].join("\n"),
  correctness: [
    "You judge whether the answer is correct for the input, given the expected answer.",
    "Reply with one JSON object and nothing else. No prose. No markdown fences.",
    '{"category":"incorrect"|"partial"|"correct","explanation":"..."}',
    "Order, lowest first: incorrect, partial, correct.",
    "incorrect: the answer is wrong. partial: some of it is right. correct: it matches.",
    "Pick the lowest category that applies.",
  ].join("\n"),
  trajectoryAccuracy: [
    "You judge how closely the actual steps follow the expected trajectory.",
    "Reply with one JSON object and nothing else. No prose. No markdown fences.",
    '{"score":0,"explanation":"..."}',
    "score is a finite number from 0 to 1. 1 means the trajectory is accurate.",
    "expected is the names that should have run. actual is the steps that did.",
  ].join("\n"),
} as const;

function requireSource(source: ModelSource): ModelSource {
  if (source.provider.trim() === "" || source.model.trim() === "") {
    throw new Error("prebuilt judge needs a non-empty provider and model");
  }
  return { provider: source.provider, model: source.model };
}

function judgeWorkflow(id: PrebuiltId, source: ModelSource): WorkflowDefinition {
  const pinned = requireSource(source);
  return defineWorkflow({
    id,
    trigger: { type: "manual" },
    steps: {
      judge: step({
        agent: defineAgent({
          id: `${id}-judge`,
          systemPrompt: RUBRIC[id],
          tools: [],
          capabilities: [],
          inference: { sources: [pinned] },
        }),
        input: { from: "trigger.payload" },
      }),
    },
  });
}

function closed(explanation: string): Outcome {
  return { pass: false, value: 0, explanation };
}

function isOutcome(value: object): value is Outcome {
  return "pass" in value && "value" in value;
}

export function faithfulness(
  source: ModelSource,
  options: { context?: (run: Run) => unknown } = {},
): Prebuilt<{ context: string; answer: string }> {
  const contextOf = options.context;
  return {
    id: "faithfulness",
    definition: judgeWorkflow("faithfulness", source),
    failure: CLOSED,
    payload: (run) => {
      if (typeof run.output !== "string") return closed("faithfulness needs a string answer");
      const context =
        contextOf !== undefined
          ? contextOf(run)
          : typeof run.expectedOutput === "string"
            ? run.expectedOutput
            : run.input;
      if (typeof context !== "string") return closed("faithfulness needs a string context");
      return { context, answer: run.output };
    },
  };
}

export function answerRelevancy(
  source: ModelSource,
): Prebuilt<{ question: string; answer: string }> {
  return {
    id: "answerRelevancy",
    definition: judgeWorkflow("answerRelevancy", source),
    failure: CLOSED,
    payload: (run) => {
      if (typeof run.input !== "string" || typeof run.output !== "string") {
        return closed("answerRelevancy needs a string question and answer");
      }
      return { question: run.input, answer: run.output };
    },
  };
}

export function correctness(
  source: ModelSource,
): Prebuilt<{ input: string; expected: string; answer: string }> {
  return {
    id: "correctness",
    definition: judgeWorkflow("correctness", source),
    failure: CLOSED,
    payload: (run) => {
      if (
        typeof run.input !== "string" ||
        typeof run.expectedOutput !== "string" ||
        typeof run.output !== "string"
      ) {
        return closed("correctness needs string input, expected, and answer");
      }
      return { input: run.input, expected: run.expectedOutput, answer: run.output };
    },
  };
}

export function trajectoryAccuracy(
  source: ModelSource,
  expected: readonly string[] | ((run: Run) => readonly string[]),
): Prebuilt<{ expected: readonly string[]; actual: readonly Step[] }> {
  return {
    id: "trajectoryAccuracy",
    definition: judgeWorkflow("trajectoryAccuracy", source),
    failure: CLOSED,
    payload: (run) => {
      const names = typeof expected === "function" ? expected(run) : expected;
      if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
        return closed("trajectoryAccuracy needs a string array of expected step names");
      }
      return { expected: names, actual: run.steps };
    },
  };
}

function asObject(output: unknown): Record<string, unknown> | undefined {
  if (typeof output === "string") {
    const text = output.trim();
    if (text.length === 0 || text.includes("```")) return undefined;
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
      return value as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
  if (isOutcome(output)) return undefined;
  return output as Record<string, unknown>;
}

function explanationOf(raw: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) return undefined;
  }
  if (!("explanation" in raw)) return "";
  return typeof raw["explanation"] === "string" ? raw["explanation"] : undefined;
}

function categoryOutcome(
  raw: Record<string, unknown>,
  scale: readonly string[],
  passAt: string,
): Outcome | undefined {
  const explanation = explanationOf(raw, ["category", "explanation"]);
  const category = raw["category"];
  if (explanation === undefined || typeof category !== "string") return undefined;
  const index = scale.indexOf(category);
  if (index < 0) return undefined;
  const outcome: Outcome = {
    pass: category === passAt,
    value: index / 2,
    label: category,
  };
  if (explanation.length > 0) outcome.explanation = explanation;
  return outcome;
}

function scoreOutcome(raw: Record<string, unknown>): Outcome | undefined {
  const explanation = explanationOf(raw, ["score", "explanation"]);
  const score = raw["score"];
  if (explanation === undefined || explanation.length === 0) return undefined;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
    return undefined;
  }
  return { pass: score === 1, value: score, explanation };
}

/** Parse one judge object. Fences, prose, a second object, or a bad score fail closed. */
export function parsePrebuilt(id: PrebuiltId, output: unknown): Outcome {
  const raw = asObject(output);
  if (raw === undefined) return CLOSED;
  if (id === "faithfulness") {
    return categoryOutcome(raw, FAITH, "supported") ?? CLOSED;
  }
  if (id === "correctness") {
    return categoryOutcome(raw, CORRECT, "correct") ?? CLOSED;
  }
  if (id === "answerRelevancy" || id === "trajectoryAccuracy") {
    return scoreOutcome(raw) ?? CLOSED;
  }
  return CLOSED;
}
