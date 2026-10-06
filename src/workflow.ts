import {
  runLocal,
  type RunLocalOptions,
  type RunResult,
  type StepInvoker,
  type WorkflowAuthorizeFn,
  type WorkflowDefinition,
} from "@intx/workflow";

import type { TaskFn, TrajectoryStep } from "./types.js";

/** Local runs need an explicit authorize; this one allows everything and says so in its name. */
export const allowAll: WorkflowAuthorizeFn = async () => ({
  effect: "allow",
  matchingGrants: [],
  resolvedBy: null,
});

export type IntxWorkflowTaskOptions<I> = {
  /** Runs each step. Wrapped so every call lands in the trajectory. */
  invokeStep: StepInvoker;
  /** What the eval treats as the run's output, read from the completed run. */
  output: (run: RunResult) => string;
  /** Maps the case input to the trigger payload. Defaults to the input itself. */
  trigger?: (input: I) => unknown;
  authorize?: WorkflowAuthorizeFn;
  /** Everything else `runLocal` accepts (actionResolver, loopFns, clock, ...). */
  runOptions?: Omit<
    RunLocalOptions,
    "invokeStep" | "authorize" | "triggerPayload" | "hasUpstreamSignalResolver"
  >;
};

/**
 * Evaluate a whole workflow as one task. Each step invocation is recorded
 * as a `TrajectoryStep` of kind `step` named after its agent, so trajectory
 * scorers (`toolCallF1` over step names, ordering checks) work unchanged.
 * A run that does not reach `completed` throws, which fails the case.
 * The case's abort signal cancels the run.
 */
export function fromIntxWorkflow<I = string>(
  definition: WorkflowDefinition,
  options: IntxWorkflowTaskOptions<I>,
): TaskFn<I> {
  return async (input, signal) => {
    if (signal?.aborted) throw new Error("eval task aborted before workflow start");
    const trajectory: TrajectoryStep[] = [];
    const invokeStep: StepInvoker = async (request) => {
      const started = Date.now();
      const step: TrajectoryStep = { name: request.agent.id, kind: "step", input: request.input };
      trajectory.push(step);
      const result = await options.invokeStep(request);
      step.latencyMs = Date.now() - started;
      step.output = "output" in result ? result.output : { suspended: result.suspend.kind };
      return result;
    };
    const started = Date.now();
    const run = runLocal(definition, {
      ...options.runOptions,
      authorize: options.authorize ?? allowAll,
      hasUpstreamSignalResolver: true,
      triggerPayload: options.trigger === undefined ? input : options.trigger(input),
      invokeStep,
    });
    const onAbort = () => {
      void run.cancel("supervisor-operator", "eval case aborted");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const finished = await run.complete;
      if (finished.terminalStatus !== "completed") {
        throw new Error(`workflow "${definition.id}" ended ${finished.terminalStatus}`);
      }
      return { output: options.output(finished), trajectory, latencyMs: Date.now() - started };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
