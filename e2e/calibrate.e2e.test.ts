import { describe, expect, test } from "bun:test";
import { defineAgent } from "@intx/agent";
import { step, type StepInvoker } from "@intx/workflow";

import { ask, calibrate } from "../src/index.js";
import { judgeModel } from "../src/workflow.js";

/** Answers yes/no questions with the input's probability; choice questions pick ready/revise by it. */
function stubCalibration(byInput: Record<string, number>) {
  const invokeStep: StepInvoker = async (request) => {
    const body = request.input as {
      state: { input: string };
      questions: Record<string, { type: string }>;
    };
    const p = byInput[body.state.input] ?? 0.5;
    const decisions = Object.entries(body.questions).map(([id, q]) =>
      q.type === "choice"
        ? {
            id,
            type: "choice",
            choice: p >= 0.5 ? "ready" : "revise",
            probabilities: { ready: p, revise: Math.round((1 - p) * 100) / 100 },
            confidence: p,
          }
        : { id, type: "noul", noul: p },
    );
    return { output: { decisions } };
  };
  return judgeModel({
    model: step({
      agent: defineAgent({
        id: "jev",
        systemPrompt: "judge",
        tools: [],
        capabilities: [],
        inference: { sources: [{ provider: "stub", model: "stub" }] },
      }),
    }),
    invokeStep,
  });
}

describe("calibrate", () => {
  const question = "Is this reply ready to send to the customer?";

  test("sweeps thresholds and recommends the most permissive clean bar", async () => {
    // a: confidently yes (label yes), b: leans no (label no), c: confidently no (label no).
    const judge = stubCalibration({ a: 0.9, b: 0.4, c: 0.1 });
    const result = await calibrate("cal", {
      run: (input: string) => `reply to ${input}`,
      cases: [
        { input: "a", labels: { ready: true } },
        { input: "b", labels: { ready: false } },
        { input: "c", labels: { ready: false } },
      ],
      checks: { ready: question },
      judge,
    });
    expect(result.total).toBe(3);
    const t = result.checks["ready"] as {
      rows: { threshold: number; agrees: number; unsure: number; disagrees: number }[];
      recommended: number;
      setting: string;
    };
    // Every verdict agrees at 0.5: yes stays yes, 0.4 and 0.1 fall in "no".
    expect(t.rows[0]).toEqual({ threshold: 0.5, agrees: 3, unsure: 0, disagrees: 0 });
    // At 0.95 the mirrored no bar is 0.05, so every case lands unsure — high bars
    // trade disagreements for unsure, never for silent agreement.
    const top = t.rows[t.rows.length - 1] as {
      threshold: number;
      agrees: number;
      unsure: number;
      disagrees: number;
    };
    expect(top).toEqual({ threshold: 0.95, agrees: 0, unsure: 3, disagrees: 0 });
    expect(t.recommended).toBe(0.5);
    expect(t.setting).toBe("{ yes: 0.5, no: 0.5 }");
    expect(result.markdown()).toContain("| 0.5 | 3 | 0 | 0 |");
    expect(result.markdown()).toContain("recommended: `{ yes: 0.5, no: 0.5 }`");
  });

  test("an ask check sweeps the sure bar instead", async () => {
    const judge = stubCalibration({ a: 0.9, b: 0.9, c: 0.9 });
    const result = await calibrate("cal", {
      run: (input: string) => `reply to ${input}`,
      cases: [
        { input: "a", labels: { ready: true } },
        { input: "b", labels: { ready: true } },
        { input: "c", labels: { ready: false } },
      ],
      checks: {
        ready: ask("Ready to send?", {
          options: { ready: "send", revise: "work" },
          pass: "ready",
        }),
      },
      judge,
    });
    const t = result.checks["ready"] as {
      rows: { threshold: number; agrees: number; unsure: number; disagrees: number }[];
      recommended: number;
    };
    // Top probability 0.9 clears every sure bar up to 0.9, so case c confidently disagrees there;
    // at 0.95 all three land unsure and nothing disagrees.
    expect(t.rows[0]).toEqual({ threshold: 0.5, agrees: 2, unsure: 0, disagrees: 1 });
    expect(t.rows[t.rows.length - 1]).toEqual({
      threshold: 0.95,
      agrees: 0,
      unsure: 3,
      disagrees: 0,
    });
    expect(t.recommended).toBe(0.95);
  });

  test("a check's own bars never pin the sweep", async () => {
    // The check carries sure: 0.6 — without stripping it, every grid row would
    // evaluate at 0.6 and the sweep would show no sensitivity at all.
    const judge = stubCalibration({ a: 0.9, b: 0.9 });
    const result = await calibrate("cal", {
      run: (input: string) => `reply to ${input}`,
      cases: [
        { input: "a", labels: { ready: true } },
        { input: "b", labels: { ready: false } },
      ],
      checks: {
        ready: ask("Ready to send?", {
          options: { ready: "send", revise: "work" },
          pass: "ready",
          sure: 0.6,
        }),
      },
      judge,
    });
    const t = result.checks["ready"] as {
      rows: { threshold: number; agrees: number; unsure: number; disagrees: number }[];
    };
    // Case b (label no) confidently disagrees at low bars, turns unsure at 0.95.
    expect(t.rows[0]).toEqual({ threshold: 0.5, agrees: 1, unsure: 0, disagrees: 1 });
    expect(t.rows[t.rows.length - 1]).toEqual({
      threshold: 0.95,
      agrees: 0,
      unsure: 2,
      disagrees: 0,
    });
  });

  test("every check needs a label on every case", async () => {
    const judge = stubCalibration({ a: 0.9 });
    await expect(
      calibrate("cal", {
        run: (input: string) => input,
        cases: [{ input: "a", labels: {} }],
        checks: { ready: question },
        judge,
      }),
    ).rejects.toThrow('case "a" has no label for check "ready"');
  });
});
