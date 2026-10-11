import { booleanResult, clamp01, normalize, scoreResult, validateScorerResult } from "./results.js";
import type { Scorer, ScorerResult } from "./types.js";

function whitespace(output: string): string {
  return output.trim().replace(/\s+/g, " ");
}

/** Boolean result. No `expected` is `false`, never a silent pass. */
export function exactMatch(): Scorer<string, string> {
  return ({ evalCase, result }) => {
    if (evalCase.expected === undefined) {
      return {
        result: booleanResult(false),
        explanation: `case "${evalCase.id}" has no expected value`,
      };
    }
    return { result: booleanResult(whitespace(result.output) === whitespace(evalCase.expected)) };
  };
}

/** F1 over `tool` and `step` names as a score. No trajectory is 0: silent tools must not pass. */
export function toolCallF1<I = unknown, E = unknown>(
  expectedTools: readonly string[],
): Scorer<I, E> {
  const expected = [...expectedTools].sort();
  return ({ evalCase, result }) => {
    if (result.trajectory === undefined) {
      return {
        result: scoreResult(0),
        explanation: `case "${evalCase.id}" produced no trajectory`,
      };
    }
    const actual = result.trajectory
      .filter((s) => s.kind === "tool" || s.kind === "step")
      .map((s) => s.name)
      .sort();
    if (expected.length === 0 && actual.length === 0) {
      return { result: scoreResult(1), explanation: "expected no tool calls, got none" };
    }
    const counts = new Map<string, number>();
    for (const name of actual) counts.set(name, (counts.get(name) ?? 0) + 1);
    let overlap = 0;
    for (const name of expected) {
      const left = counts.get(name) ?? 0;
      if (left > 0) {
        overlap += 1;
        counts.set(name, left - 1);
      }
    }
    const precision = actual.length === 0 ? 0 : overlap / actual.length;
    const recall = expected.length === 0 ? 0 : overlap / expected.length;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return {
      result: scoreResult(clamp01(f1)),
      explanation: `expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
    };
  };
}

/** Boolean result: the task finished within `maxMs`. */
export function latencyBudget<I = unknown, E = unknown>(maxMs: number): Scorer<I, E> {
  return ({ evalCase, result }) => {
    const latencyMs = result.latencyMs;
    if (latencyMs === undefined) {
      return {
        result: booleanResult(false),
        explanation: `case "${evalCase.id}" reported no latencyMs`,
      };
    }
    return {
      result: booleanResult(latencyMs <= maxMs),
      explanation: `${latencyMs}ms vs budget ${maxMs}ms`,
    };
  };
}

const STOPWORDS = new Set(
  "a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,our,their,my,your,me,him,us,do,does,did,have,has,had,will,would,can,could,should,may,might,must,not,no,yes,so,than,too,very,just,also,there,here,when,where,which,who,whom,what,how,why,because,while,until,into,over,after,before,between,through,during,each,other,some,any,such,only,own,same".split(
    ",",
  ),
);

/** Unicode-aware; numerals are kept because "3-5 days" numbers matter in evals. */
export function contentWords(text: string): string[] {
  const seen = new Set<string>();
  for (const token of text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (token === "" || STOPWORDS.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

/** Fraction of reference keywords present in the output. Word-reuse contradictions score high; pair with a judge. */
export function keywordCoverage(): Scorer<string, string> {
  return ({ evalCase, result }) => {
    if (evalCase.expected === undefined) {
      return { result: scoreResult(0), explanation: `case "${evalCase.id}" has no expected value` };
    }
    const reference = contentWords(evalCase.expected);
    if (reference.length === 0) {
      return {
        result: scoreResult(0),
        explanation: `case "${evalCase.id}" expected has no content words`,
      };
    }
    const response = new Set(contentWords(result.output));
    const matched = reference.filter((w) => response.has(w));
    return {
      result: scoreResult(matched.length / reference.length),
      explanation: `${matched.length}/${reference.length} keywords: ${matched.join(", ")}`,
    };
  };
}

async function runMember<I, E>(
  name: string,
  scorer: Scorer<I, E>,
  args: Parameters<Scorer<I, E>>[0],
): Promise<ScorerResult | string> {
  try {
    return validateScorerResult(name, await scorer(args));
  } catch (cause) {
    return `scorer "${name}" threw: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

/**
 * Mean of the members' normalized results as one score. Members are kept
 * in `metadata.members` so a low composite stays diagnosable. Booleans
 * count 1/0; categories need a scale to contribute anything but 0. An
 * invalid or throwing member makes the composite throw, so it fails closed.
 */
export function combineAll<I, E>(scorers: readonly Scorer<I, E>[]): Scorer<I, E> {
  if (scorers.length === 0) throw new Error("combineAll needs at least one scorer");
  return async (args) => {
    const checked = await Promise.all(
      scorers.map((s, i) => runMember(`combineAll[${i}]`, s, args)),
    );
    const members: ScorerResult[] = [];
    const failures: string[] = [];
    for (const m of checked) {
      if (typeof m === "string") failures.push(m);
      else members.push(m);
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
    const values = members.map((m) => normalize(m.result, false));
    return {
      result: scoreResult(values.reduce((t, v) => t + v, 0) / values.length),
      explanation: members.map((m, i) => `${i}=${values[i]?.toFixed(2)}`).join(", "),
      metadata: { members },
    };
  };
}
