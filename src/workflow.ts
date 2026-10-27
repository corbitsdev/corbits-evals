import {
  defineWorkflow,
  runLocal,
  type RunLocalOptions,
  type RunResult,
  type StepInvoker,
  type StepPrimitive,
  type WorkflowAuthorizeFn,
  type WorkflowDefinition,
} from "@intx/workflow";

import { TRACE, type Traced } from "./runs.js";
import { jev, type Escalation, type Judge, type Thresholds } from "./jev.js";
import { toMs, type Duration } from "./timeout.js";
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

export type JudgeModelOptions = {
  /** A step, or a workflow whose only primitive is that step. */
  model: StepPrimitive | WorkflowDefinition;
  /** Runs the judge step. Required: a definition alone cannot call a model. */
  invokeStep: StepInvoker;
  thresholds?: Thresholds;
  escalate?: Escalation;
  /** Bounds the judge step. */
  timeout?: Duration;
};

function isWorkflow(model: StepPrimitive | WorkflowDefinition): model is WorkflowDefinition {
  return "steps" in model && "stepOrder" in model;
}

/**
 * `defineWorkflow` stamps a lone step that omits `input` with this selector.
 * It is the same binding `judgeModel` forces, so it is not a custom input.
 */
function isStampedTriggerInput(input: NonNullable<StepPrimitive["input"]>): boolean {
  return "from" in input && input.from === "trigger.payload" && Object.keys(input).length === 1;
}

function assertJudgeStep(step: StepPrimitive): void {
  if (step.kind !== "step") throw new Error("judgeModel: the only primitive must be a step");
  if (step.input !== undefined && !isStampedTriggerInput(step.input)) {
    throw new Error("judgeModel: step must not set input");
  }
  if (step.inference !== undefined) throw new Error("judgeModel: step must not set inference");
  if (step.triggers !== undefined && step.triggers !== 1) {
    throw new Error("judgeModel: step triggers must be 1");
  }
}

function takeJudgeStep(model: StepPrimitive | WorkflowDefinition): StepPrimitive {
  if (!isWorkflow(model)) {
    if (!("kind" in model) || model.kind !== "step") {
      throw new Error("judgeModel: model must be a step or a one-step workflow");
    }
    assertJudgeStep(model);
    return model;
  }
  if (model.triggers.length !== 1)
    throw new Error("judgeModel: workflow must have exactly one trigger");
  if (model.stepOrder.length === 0) throw new Error("judgeModel: workflow has no steps");
  if (model.stepOrder.length !== 1)
    throw new Error("judgeModel: workflow must have exactly one step");
  const id = model.stepOrder[0] as string;
  const primitive = model.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error("judgeModel: the only primitive must be a step");
  }
  assertJudgeStep(primitive);
  return primitive;
}

/**
 * A Jev judge whose model is one workflow step. The step input is forced to
 * the trigger payload `{ state, questions }`, so the agent's inference sources
 * never enter the request. One `invokeStep` call per case attempt. The step
 * output is the judge reply: `{ decisions }` or `{ fallback: true, reason }`.
 */
export function judgeModel(options: JudgeModelOptions): Judge {
  if (options.invokeStep === undefined) throw new Error("judgeModel needs invokeStep");
  const primitive = takeJudgeStep(options.model);
  const timeoutMs =
    options.timeout === undefined ? undefined : toMs(options.timeout, "judgeModel timeout");
  const forced: StepPrimitive = {
    ...primitive,
    id: "",
    input: { from: "trigger.payload" },
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  };
  const definition = defineWorkflow({
    id: "jev-judge",
    trigger: { type: "manual" },
    steps: { judge: forced },
  });
  const base = jev({
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.escalate === undefined ? {} : { escalate: options.escalate }),
  });
  return {
    ...base,
    invoke: async (payload) => {
      let calls = 0;
      const run = runLocal(definition, {
        authorize: allowAll,
        hasUpstreamSignalResolver: true,
        triggerPayload: payload,
        invokeStep: async (request) => {
          calls += 1;
          if (calls > 1) throw new Error("judgeModel: more than one invoke");
          try {
            const result = await options.invokeStep(request);
            if ("suspend" in result) {
              return {
                output: { fallback: true, reason: "network", detail: "judge step suspended" },
              };
            }
            return result;
          } catch (cause) {
            return {
              output: {
                fallback: true,
                reason: "network",
                detail: cause instanceof Error ? cause.message : String(cause),
              },
            };
          }
        },
      });
      const finished = await run.complete;
      if (finished.terminalStatus !== "completed") {
        return {
          fallback: true,
          reason: "network",
          detail: `judge step ended ${finished.terminalStatus}`,
        };
      }
      return finished.outputs["judge"];
    },
  };
}
