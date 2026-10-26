import { expect, test } from "bun:test";

import { parseJsonl } from "./datasets.js";

test("parseJsonl loads expectedOutput and rejects expect or expected", () => {
  expect(parseJsonl('{"input":"hi","expectedOutput":"HI"}\n')).toEqual([
    { input: "hi", expectedOutput: "HI" },
  ]);
  expect(() => parseJsonl('{"input":"hi","expect":"HI"}\n')).toThrow("expectedOutput");
  expect(() => parseJsonl('{"input":"hi","expected":"HI"}\n')).toThrow("expectedOutput");
});
