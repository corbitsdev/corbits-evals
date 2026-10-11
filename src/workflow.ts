import {
  runLocal,
  type RunLocalOptions,
  type RunResult,
  type StepInvoker,
  type WorkflowAuthorizeFn,
  type WorkflowDefinition,
} from "@intx/workflow";

import { TRACE, type Traced } from "./runs.js";
import type { Step } from "./types.js";

const allowAll: WorkflowAuthorizeFn = async () => ({
  effect: "allow",
  matchingGrants: [],
  resolvedBy: null,
});

export type WorkflowRunOptions<I, O> = {
  /** Runs each step. Wrapped so every call lands in `steps`. */
  invokeStep: StepInvoker;
  /** The run's output. Defaults to the output of the last listed step. */
  output?: (run: RunResult) => O;
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
 * Run a whole workflow per case. A definition alone cannot run locally:
 * `invokeStep` decides how each step's agent answers, so it is required.
 * Each step invocation is a step of kind `step` named after its agent.
 * A run that does not reach `completed` throws, which fails the case.
 * The case's abort signal cancels the run.
 */
export function workflow<I = unknown, O = unknown>(
  definition: WorkflowDefinition,
  options: WorkflowRunOptions<I, O>,
): Traced<I, O> {
  const last = definition.stepOrder.at(-1);
  const output =
    options.output ??
    ((run: RunResult) => (last === undefined ? undefined : run.outputs[last]) as O);
  return {
    [TRACE]: async (input, signal) => {
      if (signal.aborted) throw new Error("run aborted before workflow start");
      const steps: Step[] = [];
      const invokeStep: StepInvoker = async (request) => {
        const started = Date.now();
        const step: Step = { name: request.agent.id, kind: "step", input: request.input };
        steps.push(step);
        const result = await options.invokeStep(request);
        step.ms = Date.now() - started;
        step.output = "output" in result ? result.output : { suspended: result.suspend.kind };
        return result;
      };
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
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const finished = await run.complete;
        if (finished.terminalStatus !== "completed") {
          throw new Error(`workflow "${definition.id}" ended ${finished.terminalStatus}`);
        }
        return { output: output(finished), steps };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
