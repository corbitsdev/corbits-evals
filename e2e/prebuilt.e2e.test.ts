import { describe, expect, test } from "bun:test";

import { includes, matches, runEvaluation } from "../src/index.js";
import {
  answerRelevancy,
  correctness,
  faithfulness,
  parsePrebuilt,
  trajectoryAccuracy,
  type PrebuiltId,
} from "../src/workflow.js";

const source = { provider: "ollama", model: "pinned" };

function judgeOf(
  id: PrebuiltId,
  definition: { steps: Record<string, unknown>; stepOrder: readonly string[] },
) {
  expect(definition.stepOrder).toEqual(["judge"]);
  const judge = definition.steps["judge"];
  expect(judge).toMatchObject({
    kind: "step",
    input: { from: "trigger.payload" },
    agent: {
      id: `${id}-judge`,
      capabilities: [],
      inference: { sources: [source] },
    },
  });
  const agent = (judge as { agent: { toolFactories: unknown[]; systemPrompt: string } }).agent;
  expect(agent.toolFactories).toEqual([]);
  expect(agent.systemPrompt.length).toBeGreaterThan(0);
}

describe("includes", () => {
  test("matches and includes share one string expectedOutput", async () => {
    const report = await runEvaluation({
      name: "includes-mix",
      task: (input: string) => `Answer: ${input}`,
      data: [{ input: "Refund", expectedOutput: "  reFUND  " }],
      scorers: { exact: matches(), has: includes() },
      allow: { exact: 1 },
    });
    expect(report.ok).toBe(true);
    expect(report.cases[0]?.checks["exact"]?.pass).toBe(false);
    expect(report.cases[0]?.checks["has"]).toEqual({ pass: true, value: 1 });
  });

  test("fails closed on a non-string, a missing expected, or an empty needle", () => {
    const check = includes();
    const run = { input: "", steps: [], ms: 0 };
    expect(check({ ...run, output: { a: 1 }, expectedOutput: '{"a":1}' })).toMatchObject({
      pass: false,
      value: 0,
    });
    expect(check({ ...run, output: "hello" })).toMatchObject({ pass: false, value: 0 });
    expect(check({ ...run, output: "hello", expectedOutput: " \n\t " })).toMatchObject({
      pass: false,
      value: 0,
    });
    expect(check({ ...run, output: "see the ﬁle  now", expectedOutput: "file now" })).toEqual({
      pass: true,
      value: 1,
    });
  });
});

describe("prebuilt judges", () => {
  test("each factory is one judge step pinned to the source", () => {
    const run = {
      input: "q",
      output: "a",
      expectedOutput: "e",
      steps: [{ name: "lookup", kind: "tool" as const }],
      ms: 1,
    };
    const checks = [
      faithfulness(source),
      answerRelevancy(source),
      correctness(source),
      trajectoryAccuracy(source, ["lookup"]),
    ];
    for (const check of checks) judgeOf(check.id, check.definition);
    expect(faithfulness(source).payload(run)).toEqual({ context: "e", answer: "a" });
    expect(faithfulness(source, { context: () => "ctx" }).payload(run)).toEqual({
      context: "ctx",
      answer: "a",
    });
    expect(answerRelevancy(source).payload({ ...run, expectedOutput: "ignored" })).toEqual({
      question: "q",
      answer: "a",
    });
    expect(correctness(source).payload(run)).toEqual({ input: "q", expected: "e", answer: "a" });
    expect(trajectoryAccuracy(source, (r) => r.steps.map((s) => s.name)).payload(run)).toEqual({
      expected: ["lookup"],
      actual: run.steps,
    });
    expect(faithfulness(source).payload({ ...run, output: 1 })).toMatchObject({
      pass: false,
      value: 0,
    });
    expect(() => faithfulness({ provider: "", model: "m" })).toThrow("non-empty");
  });

  test("parsePrebuilt accepts one object and rejects fences and a score past 1", () => {
    expect(parsePrebuilt("faithfulness", { category: "supported" })).toEqual({
      pass: true,
      value: 1,
      label: "supported",
    });
    expect(parsePrebuilt("faithfulness", '{"category":"unverifiable"}')).toMatchObject({
      pass: false,
      value: 0.5,
      label: "unverifiable",
    });
    expect(
      parsePrebuilt("correctness", { category: "incorrect", explanation: "no" }),
    ).toMatchObject({
      pass: false,
      value: 0,
      label: "incorrect",
    });
    expect(parsePrebuilt("answerRelevancy", { score: 1, explanation: "on topic" })).toEqual({
      pass: true,
      value: 1,
      explanation: "on topic",
    });
    expect(
      parsePrebuilt("trajectoryAccuracy", { score: 0.5, explanation: "missed a step" }),
    ).toEqual({
      pass: false,
      value: 0.5,
      explanation: "missed a step",
    });
    const fenced = '```json\n{"score":1,"explanation":"ok"}\n```';
    expect(parsePrebuilt("answerRelevancy", fenced)).toEqual({
      pass: false,
      value: 0,
      explanation: "judge output failed closed",
    });
    expect(parsePrebuilt("answerRelevancy", { score: 1.5, explanation: "too high" })).toEqual({
      pass: false,
      value: 0,
      explanation: "judge output failed closed",
    });
    expect(
      parsePrebuilt("correctness", '{"category":"correct"}{"category":"incorrect"}'),
    ).toMatchObject({ pass: false, value: 0 });
    expect(parsePrebuilt("faithfulness", "the answer is supported")).toMatchObject({
      pass: false,
      value: 0,
    });
  });
});
