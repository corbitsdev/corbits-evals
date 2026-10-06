import { describe, expect, test } from "bun:test";

import { defineEval, runEval } from "../src/runner.js";
import { diffReports, toJson, toJUnit, toMarkdown } from "../src/reports.js";
import type { EvalReport, Scorer } from "../src/types.js";
import { exactMatch, latencyBudget } from "../src/scorers.js";
import { score, success } from "../src/results.js";
import { fromFunction } from "../src/tasks.js";

const upper = fromFunction((input: string) => input.toUpperCase());

describe("runEval", () => {
  test("scores a small dataset and meets thresholds", async () => {
    const spec = defineEval({
      name: "upper",
      dataset: [
        { id: "a", input: "hi", expected: "HI" },
        { id: "b", input: "yo", expected: "YO" },
        { id: "c", input: "no", expected: "YES" },
      ],
      task: upper,
      scorers: { exact: exactMatch() },
      thresholds: { passRate: 0.5, avgScore: 0.5 },
    });
    const report = await runEval(spec);
    expect(report.total).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.passRate).toBeCloseTo(2 / 3, 5);
    expect(report.thresholdsMet).toBe(true);
    expect(report.cases.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("unmet thresholds are reported, not thrown", async () => {
    const spec = defineEval({
      name: "strict",
      dataset: [{ id: "a", input: "hi", expected: "BYE" }],
      task: upper,
      scorers: { exact: exactMatch() },
      thresholds: { passRate: 1 },
    });
    const report = await runEval(spec);
    expect(report.passed).toBe(0);
    expect(report.thresholdsMet).toBe(false);
  });

  test("task errors fail the case closed", async () => {
    const spec = defineEval({
      name: "boom",
      dataset: [{ id: "a", input: "hi", expected: "HI" }],
      task: fromFunction(() => {
        throw new Error("kaput");
      }),
      scorers: { exact: exactMatch() },
    });
    const report = await runEval(spec);
    expect(report.cases[0]?.pass).toBe(false);
    expect(report.cases[0]?.error).toBe("kaput");
  });

  test("a hanging task times out and fails the case closed", async () => {
    const spec = defineEval({
      name: "slow",
      dataset: [{ id: "a", input: "hi", expected: "HI" }],
      task: () => new Promise<never>(() => {}),
      scorers: { exact: exactMatch() },
      timeoutMs: 50,
    });
    const report = await runEval(spec);
    expect(report.cases[0]?.pass).toBe(false);
    expect(report.cases[0]?.error).toContain("timed out");
  });

  test("reports render markdown and junit", async () => {
    const spec = defineEval({
      name: "rep",
      dataset: [{ id: "a", input: "hi", expected: "HI" }],
      task: upper,
      scorers: { exact: exactMatch() },
    });
    const report = await runEval(spec);
    expect(toMarkdown(report)).toContain("# eval: rep");
    const junit = toJUnit(report);
    expect(junit).toContain("<testsuite");
    expect(junit).toContain('name="a"');
  });
});

describe("runEval hardening", () => {
  test("a hanging scorer times out and fails itself closed", async () => {
    const report = await runEval(
      defineEval({
        name: "slow-scorer",
        dataset: [{ id: "a", input: "hi", expected: "HI" }],
        task: upper,
        scorers: { exact: exactMatch(), stuck: () => new Promise(() => {}) },
        timeoutMs: 50,
      }),
    );
    const kase = report.cases[0];
    expect(kase?.pass).toBe(false);
    expect(kase?.error).toBeUndefined();
    expect(kase?.scorers["exact"]?.pass).toBe(true);
    expect(kase?.scorers["stuck"]?.explanation).toContain("timed out");
  });

  test("a throwing scorer fails itself, not its siblings", async () => {
    const report = await runEval(
      defineEval({
        name: "bad-scorer",
        dataset: [{ id: "a", input: "hi", expected: "HI" }],
        task: upper,
        scorers: {
          exact: exactMatch(),
          boom: () => {
            throw new Error("kaput");
          },
        },
      }),
    );
    expect(report.cases[0]?.scorers["exact"]?.pass).toBe(true);
    expect(report.cases[0]?.scorers["boom"]?.explanation).toContain("kaput");
    expect(report.cases[0]?.pass).toBe(false);
  });

  test("invalid scorer results fail closed", async () => {
    const report = await runEval(
      defineEval({
        name: "nan",
        dataset: [{ id: "a", input: "hi", expected: "HI" }],
        task: upper,
        scorers: { weird: () => ({ result: score(Number.NaN) }) },
      }),
    );
    expect(report.cases[0]?.pass).toBe(false);
    expect(report.avgScore).toBe(0);
  });

  test("the task aborts on timeout and fromFunction stamps latency", async () => {
    let aborted = false;
    const report = await runEval(
      defineEval({
        name: "abort",
        dataset: [{ id: "a", input: "hi", expected: "HI" }],
        task: fromFunction(
          (_input: string, signal?: AbortSignal) =>
            new Promise<string>((_, reject) => {
              signal?.addEventListener("abort", () => {
                aborted = true;
                reject(signal.reason);
              });
            }),
        ),
        scorers: { exact: exactMatch() },
        timeoutMs: 30,
      }),
    );
    expect(aborted).toBe(true);
    expect(report.cases[0]?.error).toContain("timed out");
    expect(report.cases[0]?.score).toBe(0);
    const quick = await runEval(
      defineEval({
        name: "latency",
        dataset: [{ id: "a", input: "hi", expected: "HI" }],
        task: upper,
        scorers: { budget: latencyBudget(10_000) },
      }),
    );
    expect(quick.cases[0]?.pass).toBe(true);
  });

  test("repeats report the deciding attempt", async () => {
    let calls = 0;
    const report = await runEval(
      defineEval({
        name: "flaky",
        dataset: [{ id: "a", input: "hi" }],
        task: upper,
        scorers: {
          flaky: () => {
            calls += 1;
            return calls === 1
              ? { result: success(true), label: "ready", explanation: "fine" }
              : { result: success(false), label: "revise", explanation: "bad" };
          },
        },
        repeats: 2,
      }),
    );
    const verdict = report.cases[0]?.scorers["flaky"];
    expect(verdict?.pass).toBe(false);
    expect(verdict?.label).toBe("revise");
    expect(verdict?.explanation).toContain("1/2 attempts passed");
  });

  test("bad numeric options and duplicate ids are rejected", () => {
    const base = {
      name: "opts",
      dataset: [{ id: "a", input: "hi", expected: "HI" }],
      task: upper,
      scorers: { exact: exactMatch() },
    };
    expect(() => defineEval({ ...base, concurrency: Number.NaN })).toThrow("concurrency");
    expect(() => defineEval({ ...base, repeats: 0 })).toThrow("repeats");
    expect(() => defineEval({ ...base, timeoutMs: -1 })).toThrow("timeoutMs");
    expect(() =>
      defineEval({ ...base, dataset: [...base.dataset, { id: "a", input: "x" }] }),
    ).toThrow("duplicate");
    expect(runEval({ ...base, dataset: [] })).rejects.toThrow("empty dataset");
  });

  test("reports escape their formats", async () => {
    const report = await runEval(
      defineEval({
        name: "esc",
        dataset: [{ id: "a|b\nc", input: "hi", expected: "BYE" }],
        task: fromFunction(() => {
          throw new Error("bad\u0000\u001B|<x>");
        }),
        scorers: { exact: exactMatch() },
        thresholds: { passRate: 1 },
      }),
    );
    const md = toMarkdown(report);
    expect(md).toContain("| a\\|b c |");
    expect(md).not.toContain("<x>");
    const junit = toJUnit(report);
    expect(junit.includes("\u0000") || junit.includes("\u001B")).toBe(false);
    expect(junit).toContain("<error ");
    expect(junit).toContain('name="thresholds"');
    expect(junit).toContain('errors="1"');
    expect(junit).toContain('failures="1"');
  });
});

describe("toJson / diffReports", () => {
  const dataset = [
    { id: "a", input: "hi", expected: "HI" },
    { id: "b", input: "yo", expected: "YO" },
    { id: "c", input: "no", expected: "NO" },
  ];

  test("round-trips through JSON and diffs by case id", async () => {
    const before = await runEval(
      defineEval({ name: "d", dataset, task: upper, scorers: { exact: exactMatch() } }),
    );
    const stored = JSON.parse(toJson(before)) as EvalReport & { format: number };
    expect(stored.format).toBe(1);
    const after = await runEval(
      defineEval({
        name: "d",
        dataset: [dataset[0]!, { id: "b", input: "yo", expected: "NOPE" }, { id: "d", input: "x" }],
        task: upper,
        scorers: { exact: exactMatch() },
      }),
    );
    const diff = diffReports(stored, after);
    expect(diff.regressed).toEqual(["b"]);
    expect(diff.fixed).toEqual([]);
    expect(diff.added).toEqual(["d"]);
    expect(diff.removed).toEqual(["c"]);
    expect(diff.changed).toEqual([{ id: "b", before: 1, after: 0 }]);
    expect(diff.passRateDelta).toBeLessThan(0);
  });
});

describe("author-owned thresholds", () => {
  test("per-scorer thresholds decide pass; unknown names are rejected", async () => {
    const risk: Scorer<string, string> = () => ({
      result: { kind: "category", value: "Med", scale: ["Low", "Med", "High"] },
    });
    const base = {
      name: "thr",
      dataset: [{ id: "a", input: "hi", expected: "HELLO" }],
      task: upper,
      scorers: { risk, ok: () => ({ result: success(true) }), cov: () => ({ result: score(0.6) }) },
    };
    const strict = await runEval(defineEval(base));
    expect(strict.cases[0]?.scorers["risk"]?.pass).toBe(false);
    expect(strict.cases[0]?.scorers["cov"]?.pass).toBe(false);
    const lenient = await runEval(
      defineEval({
        ...base,
        thresholds: { scorers: { risk: { allow: ["Low", "Med"] }, cov: { min: 0.5 } } },
      }),
    );
    expect(lenient.cases[0]?.pass).toBe(true);
    expect(lenient.cases[0]?.scorers["risk"]?.score).toBe(0.5);
    expect(() => defineEval({ ...base, thresholds: { scorers: { nope: { min: 1 } } } })).toThrow(
      'unknown scorer "nope"',
    );
  });
});
