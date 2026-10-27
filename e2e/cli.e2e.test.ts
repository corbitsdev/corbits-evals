import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const cli = join(root, "src/cli/index.ts");
const fixtures = join(import.meta.dir, "fixtures");

async function run(
  file: string,
  args: readonly string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", cli, "run", file, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? 1, stdout, stderr };
}

function jsonBody(stdout: string): unknown {
  return JSON.parse(stdout);
}

describe("corbits-eval run", () => {
  test("a passing evaluation exits 0", async () => {
    expect((await run(join(fixtures, "pass.ts"))).code).toBe(0);
  });

  test("a failed gate exits 1", async () => {
    expect((await run(join(fixtures, "fail.ts"))).code).toBe(1);
  });

  test("a module with no spec exits 2", async () => {
    expect((await run(join(fixtures, "missing-export.ts"))).code).toBe(2);
  });

  test("a missing file exits 2", async () => {
    expect((await run(join(fixtures, "does-not-exist.ts"))).code).toBe(2);
  });

  test("--format json stdout is only JSON for a pass and a gate failure", async () => {
    const passed = await run(join(fixtures, "pass.ts"), ["--format", "json"]);
    expect(passed.code).toBe(0);
    expect(passed.stdout).not.toContain("cases passed");
    expect(jsonBody(passed.stdout)).toMatchObject({ name: "pass", ok: true });

    const failed = await run(join(fixtures, "fail.ts"), ["--format", "json"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).not.toContain("cases passed");
    expect(jsonBody(failed.stdout)).toMatchObject({ code: "EVAL_FAILED" });
  });

  test("--json stdout is only JSON for a pass and a gate failure", async () => {
    const passed = await run(join(fixtures, "pass.ts"), ["--json"]);
    expect(passed.code).toBe(0);
    expect(passed.stdout).not.toContain("cases passed");
    expect(jsonBody(passed.stdout)).toMatchObject({ name: "pass", ok: true });

    const failed = await run(join(fixtures, "fail.ts"), ["--json"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).not.toContain("cases passed");
    expect(jsonBody(failed.stdout)).toMatchObject({ code: "EVAL_FAILED" });
  });

  test("a non-spec export exits 2", async () => {
    const result = await run(join(fixtures, "not-a-spec.ts"));
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("no evaluation spec");
    expect(result.stdout).not.toContain("cases.map is not a function");
  });

  test("empty data exits 2", async () => {
    const result = await run(join(fixtures, "empty.ts"));
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("EVAL_CONFIG");
    expect(result.stdout).toContain("has no data");
  });

  test("a string scorer with no judge exits 2", async () => {
    const result = await run(join(fixtures, "needs-judge.ts"));
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("EVAL_CONFIG");
    expect(result.stdout).toContain("string and ask checks need judge.invoke");
  });
});
