import type { EvalCase } from "./types.js";

type Row = Record<string, unknown>;

function rejectDuplicates(cases: EvalCase<unknown, unknown>[], source: string): void {
  const seen = new Map<string, number>();
  cases.forEach((kase, i) => {
    const first = seen.get(kase.id);
    if (first !== undefined) {
      throw new Error(`${source}: duplicate case id "${kase.id}" (rows ${first + 1} and ${i + 1})`);
    }
    seen.set(kase.id, i);
  });
}

function toCase(row: Row, source: string, line: number): EvalCase<unknown, unknown> {
  const id = row["id"];
  if (typeof id !== "string" || id === "") {
    throw new Error(`${source}:${line}: "id" must be a non-empty string`);
  }
  if (!("input" in row)) throw new Error(`${source}:${line}: missing "input"`);
  const kase: EvalCase<unknown, unknown> = { id, input: row["input"] };
  if (row["expected"] !== undefined) kase.expected = row["expected"];
  const metadata = row["metadata"];
  if (metadata !== undefined) {
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      throw new Error(`${source}:${line}: "metadata" must be an object`);
    }
    kase.metadata = metadata as Record<string, unknown>;
  }
  return kase;
}

/** One JSON object per line. Blank lines are skipped. */
export function parseJsonl<I = string, E = string>(
  text: string,
  source = "jsonl",
): EvalCase<I, E>[] {
  const cases: EvalCase<unknown, unknown>[] = [];
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
    cases.push(toCase(row as Row, source, i + 1));
  });
  rejectDuplicates(cases, source);
  return cases as EvalCase<I, E>[];
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/**
 * Header row names the columns; `id` and `input` are required, `expected`
 * is optional, every other column lands in `metadata`. Values stay strings.
 * Fields may not contain newlines.
 */
export function parseCsv(text: string, source = "csv"): EvalCase<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const headerLine = lines[0];
  if (headerLine === undefined) throw new Error(`${source}: empty file`);
  const header = splitCsvLine(headerLine);
  for (const required of ["id", "input"]) {
    if (!header.includes(required)) throw new Error(`${source}: header lacks "${required}"`);
  }
  const cases = lines.slice(1).map((line, i) => {
    const fields = splitCsvLine(line);
    if (fields.length !== header.length) {
      throw new Error(`${source}:${i + 2}: expected ${header.length} fields, got ${fields.length}`);
    }
    const row: Row = {};
    const metadata: Record<string, unknown> = {};
    header.forEach((name, col) => {
      const value = fields[col] ?? "";
      if (name === "id" || name === "input") row[name] = value;
      else if (name === "expected") {
        if (value !== "") row["expected"] = value;
      } else metadata[name] = value;
    });
    if (Object.keys(metadata).length > 0) row["metadata"] = metadata;
    return toCase(row, source, i + 2);
  });
  rejectDuplicates(cases, source);
  return cases as EvalCase<string, string>[];
}

export async function fromJsonl<I = string, E = string>(path: string): Promise<EvalCase<I, E>[]> {
  return parseJsonl<I, E>(await Bun.file(path).text(), path);
}

export async function fromCsv(path: string): Promise<EvalCase<string, string>[]> {
  return parseCsv(await Bun.file(path).text(), path);
}
