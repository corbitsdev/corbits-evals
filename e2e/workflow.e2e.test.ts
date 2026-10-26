import { describe, expect, test } from "bun:test";
import { defineAgent } from "@intx/agent";
import { defineWorkflow, step, type StepInvoker } from "@intx/workflow";

import { EvalFailure, runEvaluation, matches, ranSteps, under } from "../src/index.js";
import { workflow } from "../src/workflow.js";

function agent(id: string) {
  return defineAgent({
    id,
    systemPrompt: id,
    tools: [],
    capabilities: [],
    inference: { sources: [{ provider: "stub", model: "stub" }] },
  });
}

// draft -> review: two agents, the second reads the first's output.
const pipeline = defineWorkflow({
  id: "support-reply",
  trigger: { type: "manual" },
  steps: {
    draft: step({ agent: agent("drafter"), input: { from: "trigger.payload" } }),
    review: step({
      agent: agent("reviewer"),
      input: { from: "steps.draft.output" },
      after: ["draft"],
    }),
  },
});

const invokeStep: StepInvoker = async ({ agent: a, input }) => {
  if (a.id === "drafter") return { output: `draft: ${String(input)}` };
  return { output: String(input).toUpperCase() };
};

describe("workflow runs", () => {
  test("output defaults to the last step and every step is recorded", async () => {
    const report = await runEvaluation({
      name: "workflow",
      task: workflow<string, string>(pipeline, { invokeStep }),
      data: [{ input: "refund me", expectedOutput: "DRAFT: REFUND ME" }],
      scorers: {
        exact: matches(),
        order: (r) => r.steps.map((s) => s.name).join(">") === "drafter>reviewer",
        steps: ranSteps(["drafter", "reviewer"]),
        fast: under({ ms: 5_000 }),
      },
    });
    expect(report.ok).toBe(true);
    const [draft, review] = report.cases[0]?.steps ?? [];
    expect(draft).toMatchObject({
      name: "drafter",
      kind: "step",
      input: "refund me",
      output: "draft: refund me",
    });
    expect(review?.output).toBe("DRAFT: REFUND ME");
    expect(typeof review?.ms).toBe("number");
  });

  test("output and trigger pick object values", async () => {
    const report = await runEvaluation({
      name: "workflow-object",
      task: workflow(pipeline, {
        invokeStep,
        trigger: (input: { order: number }) => `order ${input.order}`,
        output: (run) => ({ draft: run.outputs["draft"], review: run.outputs["review"] }),
      }),
      data: [
        {
          input: { order: 42 },
          expectedOutput: { draft: "draft: order 42", review: "DRAFT: ORDER 42" },
        },
      ],
    });
    expect(report.ok).toBe(true);
  });

  test("a failing step fails the case closed", async () => {
    try {
      await runEvaluation({
        name: "workflow-fail",
        task: workflow(pipeline, {
          invokeStep: async ({ agent: a }) => {
            if (a.id === "reviewer") throw new Error("reviewer down");
            return { output: "draft" };
          },
        }),
        data: [{ input: "x", expectedOutput: "X" }],
      });
      throw new Error("expected a failure");
    } catch (cause) {
      if (!(cause instanceof EvalFailure)) throw cause;
      expect(cause.report.cases[0]?.error).toContain('workflow "support-reply" ended failed');
    }
  });
});
