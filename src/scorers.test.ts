import { describe, expect, test } from "bun:test";

import { category, meets, normalize, score, success } from "./results.js";
import { combineAll, exactMatch, keywordCoverage, toolCallF1 } from "./scorers.js";

describe("exactMatch", () => {
  test("boolean result on normalized equality", async () => {
    const verdict = await exactMatch()({
      kase: { id: "a", input: "hi", expected: "hello  world" },
      result: { output: "hello world" },
    });
    expect(verdict.result).toEqual(success(true));
  });

  test("false without an expected value", async () => {
    const verdict = await exactMatch()({
      kase: { id: "b", input: "hi" },
      result: { output: "hi" },
    });
    expect(verdict.result).toEqual(success(false));
  });
});

describe("toolCallF1", () => {
  test("perfect sequence scores 1", async () => {
    const verdict = await toolCallF1(["search", "refund"])({
      kase: { id: "c", input: "refund me" },
      result: {
        output: "done",
        trajectory: [
          { name: "search", kind: "tool" },
          { name: "refund", kind: "tool" },
        ],
      },
    });
    expect(verdict.result).toEqual(score(1));
  });

  test("missing trajectory scores 0", async () => {
    const verdict = await toolCallF1(["search"])({
      kase: { id: "d", input: "x" },
      result: { output: "x" },
    });
    expect(verdict.result).toEqual(score(0));
  });

  test("expecting no tools scores 1 only when none were called", async () => {
    const none = await toolCallF1([])({
      kase: { id: "n", input: "x" },
      result: { output: "x", trajectory: [] },
    });
    expect(none.result).toEqual(score(1));
    const extra = await toolCallF1([])({
      kase: { id: "n2", input: "x" },
      result: { output: "x", trajectory: [{ name: "search", kind: "tool" }] },
    });
    expect(extra.result).toEqual(score(0));
  });
});

describe("keywordCoverage", () => {
  test("paraphrase scores high where exact text differs", async () => {
    const verdict = await keywordCoverage()({
      kase: { id: "k", input: "capital?", expected: "Paris is the capital of France" },
      result: { output: "France's capital city is Paris" },
    });
    expect(verdict.result.kind).toBe("score");
    expect(verdict.result.value).toBeGreaterThanOrEqual(0.5);
  });

  test("scores 0 when expected has no content words", async () => {
    const verdict = await keywordCoverage()({
      kase: { id: "e", input: "x", expected: "the and of" },
      result: { output: "anything" },
    });
    expect(verdict.result).toEqual(score(0));
  });

  test("handles non-ASCII and numeric references", async () => {
    const ok = await keywordCoverage()({
      kase: { id: "jp", input: "x", expected: "東京 café 42" },
      result: { output: "Visit 東京, drink café, pay 42" },
    });
    expect(ok.result).toEqual(score(1));
    const miss = await keywordCoverage()({
      kase: { id: "num", input: "x", expected: "42" },
      result: { output: "17" },
    });
    expect(miss.result).toEqual(score(0));
  });
});

describe("combineAll", () => {
  test("rejects an empty list and keeps member results", async () => {
    expect(() => combineAll([])).toThrow();
    const verdict = await combineAll<string, string>([exactMatch(), keywordCoverage()])({
      kase: { id: "c", input: "x", expected: "hello world" },
      result: { output: "hello there" },
    });
    expect(verdict.result).toEqual(score(0.25));
    expect(verdict.metadata?.["members"]).toHaveLength(2);
  });
});

describe("results", () => {
  test("defaults: score must be 1, boolean true, category top of scale", () => {
    expect(meets(score(1), undefined).pass).toBe(true);
    expect(meets(score(0.99), undefined).pass).toBe(false);
    expect(meets(success(true), undefined).pass).toBe(true);
    expect(meets(category("High", ["Low", "Med", "High"]), undefined).pass).toBe(true);
    expect(meets(category("Med", ["Low", "Med", "High"]), undefined).pass).toBe(false);
    expect(meets(category("Low"), undefined)).toMatchObject({ pass: false });
  });

  test("author thresholds", () => {
    expect(meets(score(0.6), { min: 0.5 }).pass).toBe(true);
    expect(meets(success(false), { expect: false }).pass).toBe(true);
    expect(meets(category("Med"), { allow: ["Low", "Med"] }).pass).toBe(true);
    expect(meets(category("Med", ["Low", "Med", "High"]), { atLeast: "Med" }).pass).toBe(true);
    expect(meets(category("Low", ["Low", "Med", "High"]), { atLeast: "Med" }).pass).toBe(false);
  });

  test("mismatched threshold kinds fail closed with a reason", () => {
    const outcome = meets(success(true), { min: 0.5 });
    expect(outcome.pass).toBe(false);
    expect(outcome.reason).toContain("does not apply");
  });

  test("normalize", () => {
    expect(normalize(score(0.3), false)).toBe(0.3);
    expect(normalize(success(true), false)).toBe(1);
    expect(normalize(category("Med", ["Low", "Med", "High"]), false)).toBe(0.5);
    expect(normalize(category("x"), true)).toBe(1);
    expect(normalize(category("x"), false)).toBe(0);
  });
});
