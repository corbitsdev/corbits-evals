import type { Step } from "./types.js";

/** What the runner gets back from one run. */
export type Trace<O> = { output: O; steps: Step[] };

export type RunFn<I, O> = (input: I, signal: AbortSignal) => O | Promise<O>;

/** Structural `@intx/agent` Agent, so the root never imports it. */
export type AgentLike = {
  send(
    content: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ type: "reply"; reply: string } | { type: "suspended" }>;
};

export const TRACE: unique symbol = Symbol("@corbits/evals trace");

/** A run that reports its own steps, e.g. `workflow()` from `@corbits/evals/workflow`. */
export type Traced<I, O> = {
  readonly [TRACE]: (input: I, signal: AbortSignal) => Promise<Trace<O>>;
};

export type Runnable<I, O> = RunFn<I, O> | Traced<I, O> | AgentLike;

const NOT_RUNNABLE = "run must be a function, an @intx/agent Agent, or workflow()";

function isWorkflowDefinition(value: object): boolean {
  return "stepOrder" in value && "steps" in value && "triggers" in value;
}

/**
 * Agents run with no recorded steps. A raw workflow definition is refused:
 * running it needs a step invoker, which `workflow()` takes.
 */
export function toTraced<I, O>(
  run: Runnable<I, O>,
): (input: I, signal: AbortSignal) => Promise<Trace<O>> {
  if (typeof run === "function") {
    return async (input, signal) => ({ output: await run(input, signal), steps: [] });
  }
  if (typeof run !== "object" || run === null) {
    throw new Error(NOT_RUNNABLE);
  }
  if (TRACE in run) return run[TRACE];
  if ("send" in run && typeof run.send === "function") {
    return async (input, signal) => {
      if (typeof input !== "string") throw new Error("agent input must be a string");
      if (signal.aborted) throw new Error("run aborted before send");
      const res = await run.send(input, { signal });
      if (res.type !== "reply") throw new Error(`agent did not reply (got "${res.type}")`);
      return { output: res.reply as O, steps: [] };
    };
  }
  if (isWorkflowDefinition(run)) {
    throw new Error('run: wrap a workflow with workflow() from "@corbits/evals/workflow"');
  }
  throw new Error(NOT_RUNNABLE);
}
