import { describe, expect, test } from "bun:test";
import { defineAgent } from "@intx/agent";
import { defineWorkflow, step, type StepInvoker } from "@intx/workflow";

import { score, success } from "../src/results.js";
import { defineEval, runEval } from "../src/runner.js";
import { exactMatch, latencyBudget, toolCallF1 } from "../src/scorers.js";
import type { Scorer } from "../src/types.js";
import { fromIntxWorkflow } from "../src/workflow.js";

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

const stepOrder =
  (expected: readonly string[]): Scorer =>
  ({ result }) => {
    const names = (result.trajectory ?? []).filter((s) => s.kind === "step").map((s) => s.name);
    return {
      result: success(names.join(">") === expected.join(">")),
      explanation: names.join(" > "),
    };
  };

describe("fromIntxWorkflow", () => {
  test("evaluates a two-step workflow end to end with trajectory scorers", async () => {
    const report = await runEval(
      defineEval({
        name: "workflow",
        dataset: [{ id: "refund", input: "refund me", expected: "DRAFT: REFUND ME" }],
        task: fromIntxWorkflow(pipeline, {
          invokeStep,
          output: (run) => String(run.outputs["review"]),
        }),
        scorers: {
          exact: exactMatch(),
          order: stepOrder(["drafter", "reviewer"]),
          fast: latencyBudget(5_000),
        },
      }),
    );
    const kase = report.cases[0];
    expect(kase?.error).toBeUndefined();
    expect(kase?.pass).toBe(true);
    expect(kase?.scorers["order"]?.explanation).toBe("drafter > reviewer");
  });

  test("toolCallF1 scores workflow steps by name", async () => {
    const report = await runEval(
      defineEval({
        name: "workflow-f1",
        dataset: [{ id: "refund", input: "refund me" }],
        task: fromIntxWorkflow(pipeline, {
          invokeStep,
          output: (run) => String(run.outputs["review"]),
        }),
        scorers: {
          steps: toolCallF1(["drafter", "reviewer"]),
          wrong: toolCallF1(["drafter", "approver"]),
        },
      }),
    );
    const kase = report.cases[0];
    expect(kase?.scorers["steps"]?.result).toEqual(score(1));
    expect(kase?.scorers["wrong"]?.result).toEqual(score(0.5));
  });

  test("records per-step input, output and latency", async () => {
    const task = fromIntxWorkflow(pipeline, {
      invokeStep,
      output: (run) => String(run.outputs["review"]),
    });
    const out = await task("hi");
    expect(out.trajectory).toHaveLength(2);
    expect(out.trajectory?.[0]).toMatchObject({
      name: "drafter",
      kind: "step",
      input: "hi",
      output: "draft: hi",
    });
    expect(out.trajectory?.[1]?.output).toBe("DRAFT: HI");
    expect(typeof out.trajectory?.[1]?.latencyMs).toBe("number");
  });

  test("a failing step fails the case closed", async () => {
    const report = await runEval(
      defineEval({
        name: "workflow-fail",
        dataset: [{ id: "a", input: "x", expected: "X" }],
        task: fromIntxWorkflow(pipeline, {
          invokeStep: async ({ agent: a }) => {
            if (a.id === "reviewer") throw new Error("reviewer down");
            return { output: "draft" };
          },
          output: (run) => String(run.outputs["review"]),
        }),
        scorers: { exact: exactMatch() },
      }),
    );
    expect(report.cases[0]?.pass).toBe(false);
    expect(report.cases[0]?.error).toContain("failed");
  });
});
