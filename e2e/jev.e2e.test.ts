import { describe, expect, test } from "bun:test";
import type { EvaluateDeps } from "@corbits/system-one";

import {
  ask,
  EvalFailure,
  evaluate,
  jev,
  type Check,
  type Judge,
  type Outcome,
  type Report,
} from "../src/index.js";

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

/** Answers every question on a POST with `answer` and records the request bodies. */
function stubJev(answer: unknown) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    bodies.push(body);
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, answer]));
    return new Response(JSON.stringify({ model: "jev-test", answers }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as EvaluateDeps["fetch"];
  return { bodies, judge: jev({ apiKey: "test-key", deps: stubDeps(fetch) }) };
}

async function judged(check: Check<string, string, string>, judge: Judge) {
  let report: Report;
  try {
    report = await evaluate("jev", {
      run: (input: string) => `reply to ${input}`,
      cases: [{ input: "refund?", expect: "yes" }],
      checks: { judged: check },
      judge,
    });
  } catch (cause) {
    if (!(cause instanceof EvalFailure)) throw cause;
    report = cause.report;
  }
  return { outcome: report.cases[0]?.checks["judged"] };
}

async function answered(answer: unknown, check: Check<string, string, string>) {
  const { bodies, judge } = stubJev(answer);
  return { ...(await judged(check, judge)), bodies };
}

describe("sentence checks", () => {
  const question = "Is this reply ready to send to the customer?";

  test("one POST for the case's Jev checks with the run as state", async () => {
    const { outcome, bodies } = await answered({ type: "noul", noul: 0.9 }, question);
    expect(outcome).toEqual({ pass: true, value: 0.9, label: "yes" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.["state"]).toEqual({
      input: "refund?",
      output: "reply to refund?",
      expect: "yes",
    });
    expect(bodies[0]?.["questions"]).toEqual({ judged: { type: "noul", instructions: question } });
  });

  test("the unsure band fails with p", async () => {
    expect((await answered({ type: "noul", noul: 0.7 }, question)).outcome?.pass).toBe(true);
    expect((await answered({ type: "noul", noul: 0.5 }, question)).outcome).toEqual({
      pass: false,
      value: 0.5,
      label: "unsure",
      explanation: "unsure (p=0.50)",
    });
    expect((await answered({ type: "noul", noul: 0.2 }, question)).outcome).toMatchObject({
      pass: false,
      label: "no",
    });
  });

  test("transport failure fails closed", async () => {
    const failing = (async () => {
      throw new TypeError("boom");
    }) as unknown as EvaluateDeps["fetch"];
    const { outcome } = await judged(
      question,
      jev({ apiKey: "test-key", deps: stubDeps(failing) }),
    );
    expect(outcome).toMatchObject({ pass: false, value: 0 });
    expect(outcome?.explanation).toContain("jev fallback");
  });
});

describe("batching", () => {
  test("a case's Jev checks answer in one call and map back by name", async () => {
    const { bodies, judge } = stubJev({ type: "noul", noul: 0.9 });
    const report = await evaluate("jev", {
      run: (input: string) => `reply to ${input}`,
      cases: [{ input: "refund?" }],
      checks: { ready: "Ready to send?", polite: "Is the tone polite?" },
      judge,
    });
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0]?.["questions"] as object)).toEqual(["ready", "polite"]);
    expect(report.cases[0]?.checks["ready"]).toEqual({ pass: true, value: 0.9, label: "yes" });
    expect(report.cases[0]?.checks["polite"]).toEqual({ pass: true, value: 0.9, label: "yes" });
  });

  test("a transport failure fails every Jev check in the batch", async () => {
    const failing = (async () => {
      throw new TypeError("boom");
    }) as unknown as EvaluateDeps["fetch"];
    let report: Report;
    try {
      await evaluate("jev", {
        run: (input: string) => input,
        cases: [{ input: "a" }],
        checks: { ready: "Ready to send?", polite: "Is the tone polite?" },
        judge: jev({ apiKey: "test-key", deps: stubDeps(failing) }),
      });
      throw new Error("expected failure");
    } catch (cause) {
      if (!(cause instanceof EvalFailure)) throw cause;
      report = cause.report;
    }
    const checks = report.cases[0]?.checks as Record<string, Outcome>;
    for (const name of ["ready", "polite"]) {
      expect(checks[name]).toMatchObject({ pass: false, value: 0 });
      expect(checks[name]?.explanation).toContain("jev fallback");
    }
  });

  test("a case that skips one Jev check keeps it out of the call", async () => {
    const { bodies, judge } = stubJev({ type: "noul", noul: 0.9 });
    await evaluate("jev", {
      run: (input: string) => input,
      cases: [{ input: "a", skip: ["polite"] }],
      checks: { ready: "Ready to send?", polite: "Is the tone polite?" },
      judge,
    });
    expect(Object.keys(bodies[0]?.["questions"] as object)).toEqual(["ready"]);
  });
});

describe("ask", () => {
  const ready = ask("Ready to send?", {
    options: { ready: "send it", revise: "needs work", escalate: "needs a human" },
    pass: ["ready", "escalate"],
  });

  test("a choice passes on a pass option and scores its probability", async () => {
    const pick = (choice: string, ready: number, revise: number) => ({
      type: "choice",
      choice,
      probabilities: { ready, revise, escalate: Math.round((1 - ready - revise) * 100) / 100 },
      confidence: Math.max(ready, revise),
    });
    expect((await answered(pick("ready", 0.8, 0.1), ready)).outcome).toEqual({
      pass: true,
      value: 0.9,
      label: "ready",
    });
    expect((await answered(pick("revise", 0.1, 0.8), ready)).outcome).toMatchObject({
      pass: false,
      label: "revise",
      explanation: 'picked "revise"',
    });
    expect((await answered(pick("ready", 0.5, 0.4), ready)).outcome).toMatchObject({
      pass: false,
      explanation: 'unsure (p=0.50 for "ready")',
    });
  });

  test("levels pass at the named level or above", async () => {
    const levels = ["poor", "fair", "good", "great"];
    const helpful = ask("How helpful is the reply?", { levels, pass: "good" });
    const graded = (score: number, top: number) => ({
      type: "score",
      score,
      legend: { "0": "poor", "1": "fair", "2": "good", "3": "great" },
      probabilities: Object.fromEntries(
        levels.map((_, i) => [
          String(i),
          i === score ? top : Math.round(((1 - top) / 3) * 100) / 100,
        ]),
      ),
      confidence: top,
    });
    expect((await answered(graded(3, 0.7), helpful)).outcome).toEqual({
      pass: true,
      value: 1,
      label: "great",
    });
    expect((await answered(graded(1, 0.7), helpful)).outcome).toMatchObject({
      pass: false,
      label: "fair",
      explanation: 'graded "fair"',
    });
    expect((await answered(graded(2, 0.4), helpful)).outcome).toMatchObject({
      pass: false,
      explanation: 'unsure (p=0.40 for "good")',
    });
  });

  test("misconfiguration throws at definition", () => {
    expect(() => ask("Ready?", { options: { ready: "yes" }, pass: "redy" })).toThrow('"redy"');
    expect(() => ask("Graded?", { levels: ["only"], pass: "only" })).toThrow("2 to 10");
    expect(() => ask(" ", { options: { a: "a" }, pass: "a" })).toThrow("needs a question");
  });
});
