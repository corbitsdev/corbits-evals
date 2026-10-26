import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Evaluation } from "./evaluation.js";

/** A missing file, a failed import, or a module with no evaluation spec. */
export class EvalFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalFileError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSpec(value: unknown): value is Evaluation<unknown, unknown, unknown> {
  return isRecord(value) && typeof value["name"] === "string" && "data" in value && "task" in value;
}

function isZeroArg(value: unknown): value is () => unknown {
  return typeof value === "function" && value.length === 0;
}

async function fromFactory(
  value: unknown,
): Promise<Evaluation<unknown, unknown, unknown> | undefined> {
  if (!isZeroArg(value)) return undefined;
  const produced: unknown = await value();
  if (isSpec(produced)) return produced;
  throw new EvalFileError("evaluation function did not return a spec");
}

/**
 * Load an evaluation module. Uses `evaluation` when it is a spec, else `default`
 * when it is a spec, else a zero-arg function on either export.
 */
export async function loadEvalFile(file: string): Promise<Evaluation<unknown, unknown, unknown>> {
  const href = pathToFileURL(resolve(file)).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(href)) as Record<string, unknown>;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new EvalFileError(`could not import ${file}: ${detail}`);
  }

  const evaluation = mod["evaluation"];
  const fallback = mod["default"];
  if (isSpec(evaluation)) return evaluation;
  if (isSpec(fallback)) return fallback;

  const produced = (await fromFactory(evaluation)) ?? (await fromFactory(fallback));
  if (produced !== undefined) return produced;
  throw new EvalFileError(`${file} has no evaluation spec export`);
}
