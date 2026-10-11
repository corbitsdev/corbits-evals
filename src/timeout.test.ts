import { expect, test } from "bun:test";

import { toMs } from "./timeout.js";

test("toMs reads ms numbers and unit strings, rejects the rest", () => {
  expect(toMs(250, "t")).toBe(250);
  expect(toMs("500ms", "t")).toBe(500);
  expect(toMs("1.5s", "t")).toBe(1_500);
  expect(toMs("2m", "t")).toBe(120_000);
  for (const bad of [0, -1, Number.NaN, "5", "5h", "s"]) {
    expect(() => toMs(bad as never, "timeout")).toThrow("timeout must be a positive duration");
  }
});
