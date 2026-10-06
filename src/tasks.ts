import type { Agent, SendResult } from "@intx/agent";

import type { EvalCase, TaskFn, TaskOutput } from "./types.js";

export function fromFunction<I>(
  fn: (input: I, signal?: AbortSignal) => Promise<string | TaskOutput> | string | TaskOutput,
): TaskFn<I> {
  return async (input, signal) => {
    const started = Date.now();
    const out = await fn(input, signal);
    const result = typeof out === "string" ? { output: out } : out;
    return result.latencyMs === undefined ? { ...result, latencyMs: Date.now() - started } : result;
  };
}

/**
 * The signal is forwarded to `agent.send` so a timed-out case cancels the
 * call instead of leaving it running. One agent is shared across cases, so
 * pass a fresh (or stateless) agent if `send` keeps conversation history.
 */
export function fromIntxAgent(agent: Pick<Agent, "send">): TaskFn<string> {
  return async (input, signal) => {
    if (signal?.aborted) throw new Error("eval task aborted before send");
    const started = Date.now();
    const res: SendResult = await agent.send(input, signal === undefined ? {} : { signal });
    if (res.type !== "reply") {
      throw new Error(`eval task: agent send did not reply (got "${res.type}")`);
    }
    return { output: res.reply, latencyMs: Date.now() - started };
  };
}

export function defaultState<I, E>(
  kase: EvalCase<I, E>,
  result: TaskOutput,
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    input: kase.input,
    output: result.output,
  };
  if (kase.expected !== undefined) state["expected"] = kase.expected;
  if (result.trajectory !== undefined) state["trajectory"] = result.trajectory;
  if (kase.metadata !== undefined) state["context"] = kase.metadata;
  return state;
}
