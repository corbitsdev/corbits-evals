import type { Case } from "./types.js";

function checkNames(
  row: Record<string, unknown>,
  key: string,
  where: string,
): string[] | undefined {
  const raw = row[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((n) => typeof n === "string")) {
    throw new Error(`${where}: "${key}" must be an array of check names`);
  }
  return raw;
}

function toCase(row: Record<string, unknown>, where: string): Case {
  const name = row["name"];
  if (name !== undefined && (typeof name !== "string" || name === "")) {
    throw new Error(`${where}: "name" must be a non-empty string`);
  }
  if (!("input" in row)) throw new Error(`${where}: missing "input"`);
  const evalCase: Case = { input: row["input"] };
  if (name !== undefined) evalCase.name = name;
  if (row["expect"] !== undefined || row["expected"] !== undefined) {
    throw new Error(`${where}: use "expectedOutput", not "expect" or "expected"`);
  }
  if (row["expectedOutput"] !== undefined) evalCase.expectedOutput = row["expectedOutput"];
  const must = checkNames(row, "must", where);
  if (must !== undefined) evalCase.must = must;
  const skip = checkNames(row, "skip", where);
  if (skip !== undefined) evalCase.skip = skip;
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
