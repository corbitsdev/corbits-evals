import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";

import {
  avoids,
  EvalFailure,
  evaluate,
  fitsSchema,
  matches,
  mentions,
  ranSteps,
  stepsAtMost,
  under,
} from "../src/index.js";
import { TRACE, type Traced } from "../src/runs.js";

const upper = (input: string) => input.toUpperCase();

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "evals-"));
}

async function failure(pending: Promise<unknown>): Promise<EvalFailure> {
  try {
    await pending;
  } catch (cause) {
    if (cause instanceof EvalFailure) return cause;
    throw cause;
  }
  throw new Error("expected evaluate to fail");
}

describe("runs", () => {
  test("a function run with the default check", async () => {
    const report = await evaluate("upper", {
      run: upper,
      cases: [
        { input: "hi", expect: "HI" },
        { name: "yo", input: "yo", expect: "YO" },
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.cases.map((c) => c.name)).toEqual(["hi", "yo"]);
    expect(report.checks["matches"]).toMatchObject({ passed: 2, counted: 2, missed: 0 });
    expect(report.cases[0]?.output).toBe("HI");
  });

  test("an agent run replies through send and honors the signal", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const agent = {
      send: async (content: string, opts?: { signal?: AbortSignal }) => {
        seen.push(opts?.signal);
        return { type: "reply" as const, reply: `re: ${content}` };
      },
    };
    const report = await evaluate("agent", {
      run: agent,
      cases: [{ input: "refund", expect: "re: refund" }],
    });
    expect(report.ok).toBe(true);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    const suspended = { send: async () => ({ type: "suspended" as const }) };
    const err = await failure(
      evaluate("agent-suspended", { run: suspended, cases: ["x"].map((input) => ({ input })) }),
    );
    expect(err.report.cases[0]?.error).toContain('did not reply (got "suspended")');
  });

  test("a raw workflow definition is refused with the fix", async () => {
    const definition = { id: "w", triggers: [], steps: {}, stepOrder: [] };
    await expect(
      evaluate("raw", { run: definition as never, cases: [{ input: "x" }] }),
    ).rejects.toThrow("@corbits/evals/workflow");
  });

  test("objects stay raw and match deeply", async () => {
    const report = await evaluate("objects", {
      run: (input: { amount: number }) => ({ decision: "refund", amount: input.amount }),
      cases: [{ input: { amount: 5 }, expect: { decision: "refund", amount: 5 } }],
      checks: {
        whole: matches(),
        decision: matches("decision"),
        amount: matches((v: { amount: number }) => v.amount),
      },
    });
    expect(report.ok).toBe(true);
    expect(report.cases[0]?.output).toEqual({ decision: "refund", amount: 5 });
  });

  test("cases load from a JSONL path with line-numbered errors", async () => {
    const dir = await tempDir();
    const path = join(dir, "cases.jsonl");
    await Bun.write(
      path,
      '{"name":"a","input":"hi","expect":"HI"}\n\n{"input":"yo","expect":"YO"}\n',
    );
    const report = await evaluate("jsonl", { run: upper, cases: path });
    expect(report.cases.map((c) => c.name)).toEqual(["a", "yo"]);
    expect(report.passed).toBe(2);
    await Bun.write(path, '{"input":"x"}\n{"name":"b"}\n');
    await expect(evaluate("jsonl-bad", { run: upper, cases: path })).rejects.toThrow(
      `${path}:2: missing "input"`,
    );
  });
});

describe("checks", () => {
  test("code checks return booleans or 0..1 numbers", async () => {
    const report = await evaluate("code", {
      run: upper,
      cases: [{ input: "hi" }],
      checks: { short: (r) => r.output.length < 5, half: () => 0.5, slow: async () => true },
      allow: { half: 1 },
    });
    const checks = report.cases[0]?.checks;
    expect(checks?.["short"]).toEqual({ pass: true, value: 1 });
    expect(checks?.["half"]).toEqual({ pass: false, value: 0.5 });
    expect(checks?.["slow"]?.pass).toBe(true);
  });

  test("helpers", async () => {
    const steps: Traced<string, string> = {
      [TRACE]: async (input) => ({
        output: `Refund issued for ${input}`,
        steps: [
          { name: "lookup", kind: "tool" },
          { name: "refund", kind: "tool" },
        ],
      }),
    };
    const report = await evaluate("helpers", {
      run: steps,
      cases: [{ input: "order 42" }],
      checks: {
        mentionsAll: mentions(["refund", "ORDER 42"]),
        mentionsSome: mentions(["refund", "credit"]),
        mentionsHalf: mentions(["refund", "credit"], { atLeast: 0.5 }),
        avoidsAll: avoids(["sorry"]),
        avoidsNot: avoids(["issued", "sorry"]),
        ran: ranSteps(["lookup", "refund"]),
        ranPartly: ranSteps(["lookup", "escalate"]),
        ranHalf: ranSteps(["lookup", "escalate"], { atLeast: 0.5 }),
        fewSteps: stepsAtMost(2),
        tooMany: stepsAtMost(1),
        fast: under({ ms: 10_000 }),
        schema: fitsSchema(type("string")),
        notSchema: fitsSchema(type("number")),
      },
      allow: { mentionsSome: 1, avoidsNot: 1, ranPartly: 1, tooMany: 1, notSchema: 1 },
    });
    const checks = report.cases[0]?.checks ?? {};
    const passes = Object.fromEntries(Object.entries(checks).map(([k, o]) => [k, o.pass]));
    expect(passes).toEqual({
      mentionsAll: true,
      mentionsSome: false,
      mentionsHalf: true,
      avoidsAll: true,
      avoidsNot: false,
      ran: true,
      ranPartly: false,
      ranHalf: true,
      fewSteps: true,
      tooMany: false,
      fast: true,
      schema: true,
      notSchema: false,
    });
    expect(checks["mentionsSome"]).toMatchObject({ value: 0.5, explanation: "missing: credit" });
    expect(checks["avoidsNot"]).toMatchObject({ value: 0.5, explanation: "found: issued" });
    expect(checks["ranPartly"]?.value).toBe(0.5);
    expect(checks["notSchema"]?.explanation).toContain("number");
    expect(() => mentions([])).toThrow("needs words");
    expect(() => under({})).toThrow("needs a budget");
    expect(() => ranSteps([], { atLeast: 0 })).toThrow("atLeast");
  });

  test("matches fails a case without expect", async () => {
    const err = await failure(evaluate("no-expect", { run: upper, cases: [{ input: "hi" }] }));
    expect(err.report.cases[0]?.checks["matches"]?.explanation).toBe("case has no expect");
  });

  test("a throwing, hanging or malformed check fails itself closed, not its siblings", async () => {
    const err = await failure(
      evaluate("bad-checks", {
        run: upper,
        cases: [{ input: "hi", expect: "HI" }],
        checks: {
          exact: matches(),
          boom: () => {
            throw new Error("kaput");
          },
          stuck: () => new Promise<boolean>(() => {}),
          weird: () => Number.NaN,
        },
        timeout: "50ms",
      }),
    );
    const checks = err.report.cases[0]?.checks;
    expect(checks?.["exact"]?.pass).toBe(true);
    expect(checks?.["boom"]?.explanation).toBe('check "boom" threw: kaput');
    expect(checks?.["stuck"]?.explanation).toContain("timed out after 50ms");
    expect(checks?.["weird"]?.explanation).toContain("invalid value");
    expect(err.report.cases[0]?.error).toBeUndefined();
  });

  test("a run error or timeout fails every check and aborts the run", async () => {
    let aborted = false;
    const err = await failure(
      evaluate("bad-runs", {
        run: (input: string, signal) => {
          if (input === "boom") throw new Error("kaput");
          return new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(signal.reason);
            });
          });
        },
        cases: [{ input: "boom" }, { input: "hang" }],
        checks: { fine: () => true },
        timeout: 30,
      }),
    );
    const [boom, hang] = err.report.cases;
    expect(boom?.error).toBe("kaput");
    expect(boom?.checks["fine"]).toMatchObject({ pass: false, explanation: "run failed: kaput" });
    expect(hang?.error).toContain("timed out after 30ms");
    expect(aborted).toBe(true);
  });
});

describe("gates", () => {
  test("repeats fail a check when any attempt fails and report the deciding one", async () => {
    let calls = 0;
    const err = await failure(
      evaluate("flaky", {
        run: upper,
        cases: [{ input: "hi" }],
        checks: {
          flaky: () => {
            calls += 1;
            return calls === 1
              ? true
              : { pass: false, value: 0, label: "revise", explanation: "bad" };
          },
        },
        repeats: 2,
      }),
    );
    expect(err.report.cases[0]?.checks["flaky"]).toEqual({
      pass: false,
      value: 0.5,
      label: "revise",
      explanation: "1/2 attempts passed; bad",
    });
  });

  test("bad options are rejected up front", async () => {
    const base = { run: upper, cases: [{ input: "a", expect: "A" }] };
    await expect(evaluate("o", { ...base, concurrency: Number.NaN })).rejects.toThrow(
      "concurrency",
    );
    await expect(evaluate("o", { ...base, repeats: 0 })).rejects.toThrow("repeats");
    await expect(evaluate("o", { ...base, timeout: "soon" as never })).rejects.toThrow("timeout");
    await expect(evaluate("o", { ...base, checks: {} })).rejects.toThrow("no checks");
    await expect(evaluate("o", { ...base, cases: [] })).rejects.toThrow("no cases");
    await expect(
      evaluate("o", { ...base, cases: [...base.cases, { input: "a" }] }),
    ).rejects.toThrow('duplicate case "a"');
  });

  test("markdown escapes cells", async () => {
    const err = await failure(
      evaluate("md", { run: upper, cases: [{ name: "a|b\nc", input: "<x>", expect: "no" }] }),
    );
    const md = err.report.markdown();
    expect(md).toContain("# eval: md");
    expect(md).toContain("| matches | 0/1 | 1 (0 allowed) | FAIL |");
    expect(md).toContain("| a\\|b c | FAIL");
    expect(md).not.toContain("<X>");
  });
});

describe("passing", () => {
  const cases = [
    { name: "a", input: "a", expect: "A" },
    { name: "b", input: "b", expect: "B" },
    { name: "c", input: "c", expect: "nope" },
  ];
  const checks = { exact: matches(), short: (r: { output: string }) => r.output.length === 1 };

  test("each check may miss as many cases as allowed", async () => {
    const strict = await failure(evaluate("strict", { run: upper, cases, checks }));
    expect(strict.message).toContain("exact: 1 missed, 0 allowed");
    expect(strict.message).toContain('c / exact: expected "nope", got "C"');
    expect(strict.report.checks["exact"]).toMatchObject({ passed: 2, counted: 3, missed: 1 });
    expect(strict.report.checks["short"]?.ok).toBe(true);

    const report = await evaluate("lenient", { run: upper, cases, checks, allow: { exact: 1 } });
    expect(report.ok).toBe(true);
    expect(report.checks["exact"]?.allow).toEqual({ miss: 1, drop: 0 });

    const long = (input: string) => input.toUpperCase().repeat(2);
    const over = await failure(
      evaluate("over", { run: long, cases, checks, allow: { exact: { miss: 3 }, short: 2 } }),
    );
    expect(over.message).toContain("short: 3 missed, 2 allowed");
    expect(over.message).not.toContain("exact:");
    expect(over.message).not.toContain("/ exact");
    expect(over.report.checks["exact"]?.ok).toBe(true);
  });

  test("must fails a check despite its allowance; skip leaves a case out", async () => {
    const must = await failure(
      evaluate("must", {
        run: upper,
        cases: cases.map((c) => (c.name === "c" ? { ...c, must: ["exact"] } : c)),
        checks,
        allow: { exact: 1 },
      }),
    );
    expect(must.message).toContain('exact: must pass "c"');
    expect(must.report.checks["exact"]).toMatchObject({ missed: 1, mustFailed: ["c"], ok: false });

    const seen: string[] = [];
    const report = await evaluate("skip", {
      run: upper,
      cases: cases.map((c) => (c.name === "c" ? { ...c, skip: ["exact"] } : c)),
      checks: {
        exact: (r) => {
          seen.push(r.input);
          return r.output === r.expect;
        },
      },
    });
    expect(seen.sort()).toEqual(["a", "b"]);
    expect(report.checks["exact"]).toMatchObject({ passed: 2, counted: 2, missed: 0 });
    expect(report.cases[2]?.checks).toEqual({});
    expect(report.markdown()).toContain("| c | skip |");
  });

  test("must and skip load from JSONL", async () => {
    const path = join(await tempDir(), "cases.jsonl");
    await Bun.write(
      path,
      '{"name":"a","input":"a","expect":"A","must":["exact"]}\n{"name":"c","input":"c","expect":"nope","skip":["exact"]}\n',
    );
    const report = await evaluate("jsonl-must", { run: upper, cases: path, checks });
    expect(report.checks["exact"]).toMatchObject({ passed: 1, counted: 1 });
    await Bun.write(path, '{"input":"a","skip":"exact"}\n');
    await expect(evaluate("jsonl-must", { run: upper, cases: path, checks })).rejects.toThrow(
      `${path}:1: "skip" must be an array of check names`,
    );
  });

  test("bad allow, must and skip names are rejected", async () => {
    const base = { run: upper, cases, checks };
    await expect(evaluate("o", { ...base, allow: { exakt: 1 } })).rejects.toThrow(
      'allow names unknown check "exakt"',
    );
    await expect(evaluate("o", { ...base, allow: { exact: -1 } })).rejects.toThrow(
      "allow.exact must be a whole number >= 0",
    );
    await expect(evaluate("o", { ...base, allow: { exact: { drop: 0.5 } } })).rejects.toThrow(
      "allow.exact.drop must be a whole number >= 0",
    );
    await expect(
      evaluate("o", { ...base, allow: { exact: { misses: 1 } as never } }),
    ).rejects.toThrow('allow.exact has unknown "misses"');
    await expect(
      evaluate("o", { ...base, cases: [{ name: "a", input: "a", must: ["nope"] }] }),
    ).rejects.toThrow('case "a" must names unknown check "nope"');
    await expect(
      evaluate("o", { ...base, cases: [{ name: "a", input: "a", skip: ["nope"] }] }),
    ).rejects.toThrow('case "a" skip names unknown check "nope"');
    await expect(
      evaluate("o", {
        ...base,
        cases: [{ name: "a", input: "a", must: ["exact"], skip: ["exact"] }],
      }),
    ).rejects.toThrow('case "a" both must and skip "exact"');
  });
});

describe("compare and save", () => {
  const cases = [
    { name: "a", input: "a", expect: "A" },
    { name: "b", input: "b", expect: "B" },
    { name: "c", input: "c", expect: "nope" },
  ];
  const allow = { matches: { miss: 2 } };
  const swap = (input: string) => (input === "b" ? "?" : input === "c" ? "nope" : "A");

  async function touchesNoFile(pending: () => Promise<unknown>): Promise<void> {
    const file = spyOn(Bun, "file");
    const write = spyOn(Bun, "write");
    try {
      await pending();
      expect(file).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      file.mockRestore();
      write.mockRestore();
    }
  }

  test("without either nothing is read or written", async () => {
    await touchesNoFile(() => evaluate("upper", { run: upper, cases, allow }));
  });

  test("save writes the run, passing or failing", async () => {
    const path = join(await tempDir(), "upper.json");
    await evaluate("upper", { run: upper, cases, allow, save: path, about: { model: "m-1" } });
    expect(JSON.parse(await Bun.file(path).text())).toEqual({
      format: 1,
      eval: "upper",
      about: { model: "m-1" },
      cases: {
        a: { matches: { pass: true, value: 1 } },
        b: { matches: { pass: true, value: 1 } },
        c: { matches: { pass: false, value: 0 } },
      },
    });

    await failure(evaluate("upper", { run: upper, cases, save: path }));
    expect(JSON.parse(await Bun.file(path).text()).about).toBeUndefined();
  });

  test("compare never writes; a missing file skips drops", async () => {
    const path = join(await tempDir(), "missing.json");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const report = await evaluate("upper", { run: swap, cases, allow, compare: path });
      expect(report.checks["matches"]?.drop).toBeUndefined();
      expect(log).toHaveBeenCalledWith(`  no compare run at ${path}`);
    } finally {
      log.mockRestore();
    }
    expect(await Bun.file(path).exists()).toBe(false);

    await evaluate("upper", { run: upper, cases, allow, save: path });
    const stored = await Bun.file(path).text();
    await evaluate("upper", { run: upper, cases, allow, compare: path });
    await failure(evaluate("upper", { run: swap, cases, allow, compare: path }));
    expect(await Bun.file(path).text()).toBe(stored);
  });

  test("one path for both compares, then overwrites", async () => {
    const path = join(await tempDir(), "upper.last.json");
    await evaluate("upper", { run: upper, cases, allow, compare: path, save: path });

    const err = await failure(
      evaluate("upper", { run: swap, cases, allow, compare: path, save: path }),
    );
    expect(err.report.changes).toEqual([
      { case: "b", check: "matches", change: "broke" },
      { case: "c", check: "matches", change: "fixed" },
    ]);
    expect(err.report.checks["matches"]).toMatchObject({ missed: 1, drop: 1, ok: false });
    expect(err.message).toContain("matches: 1 dropped, 0 allowed");
    expect(err.message).toContain("b / matches");
    expect(JSON.parse(await Bun.file(path).text()).cases.b.matches.pass).toBe(false);

    const again = await evaluate("upper", { run: swap, cases, allow, compare: path, save: path });
    expect(again.checks["matches"]?.drop).toBe(0);
  });

  test("an earlier report gates drops with no file", async () => {
    const before = await evaluate("upper", { run: upper, cases, allow });
    await touchesNoFile(async () => {
      const err = await failure(evaluate("upper", { run: swap, cases, allow, compare: before }));
      expect(err.report.checks["matches"]).toMatchObject({ drop: 1, ok: false });
      const within = await evaluate("upper", {
        run: swap,
        cases,
        allow: { matches: { miss: 1, drop: 1 } },
        compare: before,
      });
      expect(within.ok).toBe(true);
    });
    await expect(evaluate("other", { run: upper, cases, allow, compare: before })).rejects.toThrow(
      'compare is a report of eval "upper"',
    );
  });

  test("added and removed cases are reported, not counted as drops", async () => {
    const before = await evaluate("upper", { run: upper, cases, allow });
    const changed = [...cases.slice(1), { name: "d", input: "d", expect: "nope" }];
    const report = await evaluate("upper", { run: upper, cases: changed, allow, compare: before });
    expect(report.added).toEqual(["d"]);
    expect(report.removed).toEqual(["a"]);
    expect(report.checks["matches"]?.drop).toBe(0);
  });

  test("refuses another eval's run and malformed files; reads 0.1.0 files", async () => {
    const path = join(await tempDir(), "b.json");
    await evaluate("one", { run: upper, cases, allow, save: path });
    await expect(evaluate("two", { run: upper, cases, allow, compare: path })).rejects.toThrow(
      'stored run of eval "one", not "two"',
    );
    const old = { ...JSON.parse(await Bun.file(path).text()), passRate: 0.667 };
    await Bun.write(path, JSON.stringify(old));
    await evaluate("one", { run: upper, cases, allow, compare: path });
    await Bun.write(path, JSON.stringify({ format: 2 }));
    await expect(evaluate("one", { run: upper, cases, allow, compare: path })).rejects.toThrow(
      "unknown format 2",
    );
  });
});
