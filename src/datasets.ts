import type { Case } from "./types.js";

function toCase(row: Record<string, unknown>, where: string): Case {
  const name = row["name"];
  if (name !== undefined && (typeof name !== "string" || name === "")) {
    throw new Error(`${where}: "name" must be a non-empty string`);
  }
  if (!("input" in row)) throw new Error(`${where}: missing "input"`);
  const evalCase: Case = { input: row["input"] };
  if (name !== undefined) evalCase.name = name;
  if (row["expect"] !== undefined) evalCase.expect = row["expect"];
  return evalCase;
}

/** One case object per line. Blank lines are skipped. */
export function parseJsonl(text: string, source = "jsonl"): Case[] {
  const cases: Case[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "") return;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (cause) {
      throw new Error(`${source}:${i + 1}: invalid JSON (${(cause as Error).message})`);
    }
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`${source}:${i + 1}: expected an object`);
    }
    cases.push(toCase(row as Record<string, unknown>, `${source}:${i + 1}`));
  });
  return cases;
}

export async function fromJsonl(path: string): Promise<Case[]> {
  return parseJsonl(await Bun.file(path).text(), path);
}
