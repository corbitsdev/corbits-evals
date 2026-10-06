import { describe, expect, test } from "bun:test";

import { parseCsv, parseJsonl } from "../src/datasets.js";

describe("parseJsonl", () => {
  test("loads cases and skips blank lines", () => {
    const cases = parseJsonl<unknown, string>(
      '{"id":"a","input":"hi","expected":"HI"}\n\n{"id":"b","input":{"q":1},"metadata":{"tag":"x"}}\n',
    );
    expect(cases).toHaveLength(2);
    expect(cases[1]?.input).toEqual({ q: 1 });
    expect(cases[1]?.metadata).toEqual({ tag: "x" });
    expect("expected" in (cases[1] ?? {})).toBe(false);
  });

  test("reports line numbers for bad rows and duplicates", () => {
    expect(() => parseJsonl('{"id":"a","input":"x"}\n{"id":"a"}', "d.jsonl")).toThrow(
      'd.jsonl:2: missing "input"',
    );
    expect(() => parseJsonl('{"id":"a","input":"x"}\n{"id":"a","input":"y"}')).toThrow(
      "rows 1 and 2",
    );
    expect(() => parseJsonl("nope")).toThrow("invalid JSON");
    expect(() => parseJsonl('{"id":"","input":"x"}')).toThrow('"id"');
  });
});

describe("parseCsv", () => {
  test("maps header columns, quotes, and extra columns to metadata", () => {
    const cases = parseCsv('id,input,expected,tag\na,"hello, world","""HI""",t1\nb,x,,\n');
    expect(cases[0]).toEqual({
      id: "a",
      input: "hello, world",
      expected: '"HI"',
      metadata: { tag: "t1" },
    });
    expect(cases[1]).toEqual({ id: "b", input: "x", metadata: { tag: "" } });
  });

  test("rejects missing columns and ragged rows", () => {
    expect(() => parseCsv("id,expected\na,b")).toThrow('lacks "input"');
    expect(() => parseCsv("id,input\na,b,c", "d.csv")).toThrow("d.csv:2: expected 2 fields");
    expect(() => parseCsv("")).toThrow("empty");
  });
});
