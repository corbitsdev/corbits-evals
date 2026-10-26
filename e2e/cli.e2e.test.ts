import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const cli = join(root, "src/cli/index.ts");
const fixtures = join(import.meta.dir, "fixtures");

async function run(file: string): Promise<number> {
  const proc = Bun.spawn(["bun", cli, "run", file], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return proc.exitCode ?? 1;
}

describe("corbits-eval run", () => {
  test("a passing evaluation exits 0", async () => {
    expect(await run(join(fixtures, "pass.ts"))).toBe(0);
  });

  test("a failed gate exits 1", async () => {
    expect(await run(join(fixtures, "fail.ts"))).toBe(1);
  });

  test("a module with no spec exits 2", async () => {
    expect(await run(join(fixtures, "missing-export.ts"))).toBe(2);
  });

  test("a missing file exits 2", async () => {
    expect(await run(join(fixtures, "does-not-exist.ts"))).toBe(2);
  });
});
