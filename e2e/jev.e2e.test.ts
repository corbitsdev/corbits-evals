import { describe, expect, test } from "bun:test";
import type { EvaluateDeps } from "@corbits/system-one";

import { jevJudge } from "../src/jev.js";

function stubDeps(fetch: EvaluateDeps["fetch"]): EvaluateDeps {
  return {
    fetch,
    scheduler: {
      setTimeout: ((fn: () => void, ms: number) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      }) as EvaluateDeps["scheduler"]["setTimeout"],
      now: () => Date.now(),
    },
  };
}

function jsonFetch(body: unknown): EvaluateDeps["fetch"] {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as EvaluateDeps["fetch"];
}

describe("jevJudge", () => {
  test("maps a choice decision to a passing verdict in one call", async () => {
    let calls = 0;
    const inner = jsonFetch({
      model: "jev-test",
      answers: {
        ready: {
          type: "choice",
          choice: "ready",
          probabilities: { ready: 0.9, revise: 0.1 },
          confidence: 0.85,
        },
      },
    });
    const counting = (async (...args: Parameters<typeof inner>) => {
      calls += 1;
      return inner(...args);
    }) as EvaluateDeps["fetch"];
    const deps = stubDeps(counting);
    const judge = jevJudge({
      questions: [
        {
          id: "ready",
          type: "choice",
          instructions: "Is the draft ready to send?",
          criteria: { ready: "send it", revise: "needs work" },
        },
      ],
      apiKey: "test-key",
      deps,
    });
    const verdict = await judge({
      kase: { id: "a", input: "refund?", expected: "yes" },
      result: { output: "yes, refunded" },
    });
    expect(calls).toBe(1);
    expect(verdict.result).toEqual({
      kind: "category",
      value: "ready",
      scale: ["ready", "revise"],
    });
    expect(verdict.label).toBe("ready");
    expect(verdict.confidence).toBeCloseTo(0.85, 5);
  });

  test("transport failure fails closed, never passes", async () => {
    const failing = (async () => {
      throw new TypeError("boom");
    }) as EvaluateDeps["fetch"];
    const deps = stubDeps(failing);
    const judge = jevJudge({
      questions: [{ id: "ok", type: "boolean", instructions: "Is this fine?" }],
      apiKey: "test-key",
      deps,
    });
    const verdict = await judge({
      kase: { id: "b", input: "x" },
      result: { output: "y" },
    });
    expect(verdict.result).toEqual({ kind: "score", value: 0 });
    expect(verdict.explanation).toContain("fallback");
  });
});

describe("jevJudge option validation", () => {
  const question = {
    id: "ready",
    type: "choice",
    instructions: "Ready?",
    criteria: { ready: "yes", revise: "no" },
  } as const;

  test("scores for an unknown question or option throw at definition", () => {
    expect(() => jevJudge({ questions: [question], scores: { redy: { ready: 1 } } })).toThrow(
      '"redy"',
    );
    expect(() => jevJudge({ questions: [question], scores: { ready: { yes: 1 } } })).toThrow(
      'no option "yes"',
    );
    expect(() => jevJudge({ questions: [] })).toThrow("at least one");
  });

  test("graded choices become scores", async () => {
    const judge = jevJudge({
      questions: [question],
      scores: { ready: { ready: 1, revise: 0.4 } },
      apiKey: "test-key",
      deps: stubDeps(
        jsonFetch({
          model: "jev-test",
          answers: {
            ready: {
              type: "choice",
              choice: "revise",
              probabilities: { ready: 0.3, revise: 0.7 },
              confidence: 0.7,
            },
          },
        }),
      ),
    });
    const verdict = await judge({ kase: { id: "g", input: "x" }, result: { output: "y" } });
    expect(verdict.result).toEqual({ kind: "score", value: 0.4 });
    expect(verdict.label).toBe("revise");
  });

  test("a thrown evaluate error fails closed", async () => {
    const judge = jevJudge({
      questions: [{ id: "ok", type: "boolean", instructions: "Fine?" }],
      apiKey: "test-key",
      endpoint: { type: "custom" } as never,
      deps: stubDeps(jsonFetch({})),
    });
    const verdict = await judge({ kase: { id: "x", input: "x" }, result: { output: "y" } });
    expect(verdict.result).toEqual({ kind: "score", value: 0 });
    expect(verdict.explanation).toMatch(/jev (threw|fallback)/);
  });
});
