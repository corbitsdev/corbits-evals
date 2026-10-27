import type { Step } from "./types.js";

/** What the runner gets back from one run. */
export type Trace<O> = { output: O; steps: Step[] };

export type RunFn<I, O> = (input: I, signal: AbortSignal) => O | Promise<O>;

type StreamEvent = { type: string; data?: unknown };

type AgentSendResult =
  | { type: "reply"; reply: string; turn?: { model?: string } }
  | { type: "suspended" };

/** Structural `@intx/agent` Agent, so the root never imports it. */
export type AgentLike = {
  send(content: string, opts?: { signal?: AbortSignal }): Promise<AgentSendResult>;
  stream?(): AsyncIterable<StreamEvent>;
};

export const TRACE: unique symbol = Symbol("@corbits/evals trace");

/** A run that reports its own steps, e.g. `workflow()` from `@corbits/evals/workflow`. */
export type Traced<I, O> = {
  readonly [TRACE]: (input: I, signal: AbortSignal) => Promise<Trace<O>>;
};

export type Runnable<I, O> = RunFn<I, O> | Traced<I, O> | AgentLike;

const NOT_RUNNABLE = "must be a function, an @intx/agent Agent, or workflow()";

function isWorkflowDefinition(value: object): boolean {
  return "stepOrder" in value && "steps" in value && "triggers" in value;
}

const tails = new WeakMap<object, Promise<void>>();

function withAgentLock<T>(agent: object, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(agent) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(
    agent,
    prev.then(
      () => gate,
      () => gate,
    ),
  );
  return prev
    .then(
      () => fn(),
      () => fn(),
    )
    .finally(() => {
      release?.();
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function joinedText(turn: unknown): { name: string; output: string } {
  if (!isRecord(turn)) return { name: "assistant", output: "" };
  const name = typeof turn.model === "string" && turn.model.length > 0 ? turn.model : "assistant";
  if (!Array.isArray(turn.content)) return { name, output: "" };
  const parts: string[] = [];
  for (const block of turn.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return { name, output: parts.join("") };
}

type KnownCall = { name: string; input: unknown; step?: Step };

function rememberCall(
  tools: Map<string, KnownCall>,
  id: string,
  name: string,
  input: unknown,
): void {
  if (name.length === 0 || tools.has(id)) return;
  tools.set(id, { name, input });
}

/** Names a blocked call can carry without `tool.start`. */
function rememberTurnCalls(turn: unknown, tools: Map<string, KnownCall>): void {
  if (!isRecord(turn) || !Array.isArray(turn.content)) return;
  for (const block of turn.content) {
    if (!isRecord(block) || block.type !== "tool_call") continue;
    if (typeof block.id !== "string" || typeof block.name !== "string") continue;
    rememberCall(tools, block.id, block.name, block.arguments);
  }
}

function toolName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordEvent(event: StreamEvent, steps: Step[], tools: Map<string, KnownCall>): boolean {
  if (event.type === "inference.tool_call.end") {
    const data = isRecord(event.data) ? event.data : undefined;
    if (data === undefined || typeof data.callId !== "string") return false;
    const name = toolName(data.name);
    if (name === undefined) return false;
    rememberCall(tools, data.callId, name, data.arguments);
    return false;
  }
  if (event.type === "inference.done") {
    const turn = isRecord(event.data) ? event.data.turn : undefined;
    rememberTurnCalls(turn, tools);
    const text = joinedText(turn);
    steps.push({ name: text.name, kind: "llm", output: text.output });
    return true;
  }
  if (event.type === "tool.start") {
    const call = isRecord(event.data) ? event.data.call : undefined;
    if (!isRecord(call)) return false;
    const id = typeof call.id === "string" ? call.id : undefined;
    const known = id === undefined ? undefined : tools.get(id);
    const name = toolName(call.name) ?? known?.name;
    if (name === undefined) return false;
    if (known?.step !== undefined) return true;
    const step: Step = { name, kind: "tool", input: call.arguments ?? known?.input };
    steps.push(step);
    if (id !== undefined) tools.set(id, { name, input: step.input, step });
    return true;
  }
  if (event.type === "tool.done") {
    const result = isRecord(event.data) ? event.data.result : undefined;
    if (!isRecord(result) || typeof result.callId !== "string") return false;
    const known = tools.get(result.callId);
    if (known === undefined) return false;
    let step = known.step;
    if (step === undefined) {
      step = { name: known.name, kind: "tool", input: known.input };
      steps.push(step);
      known.step = step;
    }
    step.output = "content" in result ? result.content : result;
    return true;
  }
  return false;
}

type Raced<T> = { ready: true; result: T } | { ready: false };

function raceReady<T>(pending: Promise<T>): Promise<Raced<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    pending.then(
      (result) => {
        settled = true;
        resolve({ ready: true, result });
      },
      (error: unknown) => {
        settled = true;
        reject(error);
      },
    );
    queueMicrotask(() => {
      if (!settled) resolve({ ready: false });
    });
  });
}

/** Drop events already queued at subscribe. The returned read is the first live one. */
async function discardBuffered(
  iterator: AsyncIterator<StreamEvent>,
): Promise<{ pending: Promise<IteratorResult<StreamEvent>> }> {
  let pending = iterator.next();
  for (;;) {
    const raced = await raceReady(pending);
    if (!raced.ready) return { pending };
    if (raced.result.done === true) return { pending: Promise.resolve(raced.result) };
    pending = iterator.next();
  }
}

async function takeReady(
  pending: Promise<IteratorResult<StreamEvent>>,
): Promise<IteratorResult<StreamEvent> | undefined> {
  const raced = await raceReady(pending);
  if (!raced.ready) return undefined;
  return raced.result;
}

/** Quiet once a macrotask passes with no event, so a post-send `setTimeout(0)` is kept. */
async function nextEventOrIdle(
  pending: Promise<IteratorResult<StreamEvent>>,
): Promise<{ idle: true } | { idle: false; result: IteratorResult<StreamEvent> }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<{ idle: true }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ idle: true });
    }, 0);
  });
  try {
    return await Promise.race([pending.then((result) => ({ idle: false as const, result })), idle]);
  } finally {
    clearTimeout(timer);
  }
}

/** The reactor settles the in-flight send on these, then stops this turn. */
function isTurnEnd(event: StreamEvent): boolean {
  if (
    event.type === "connector.reply" ||
    event.type === "reactor.gate.blocked" ||
    event.type === "reactor.done"
  ) {
    return true;
  }
  return event.type === "reactor.error" && isRecord(event.data) && event.data.fatal === true;
}
async function collect(
  iterator: AsyncIterator<StreamEvent>,
  first: Promise<IteratorResult<StreamEvent>>,
  steps: Step[],
  send: Promise<unknown>,
  signal: AbortSignal,
): Promise<boolean> {
  let saw = false;
  const tools = new Map<string, KnownCall>();
  let sendSettled = false;
  let sendFailed = false;
  const mark = send.then(
    () => {
      sendSettled = true;
    },
    () => {
      sendSettled = true;
      sendFailed = true;
    },
  );
  const note = (event: StreamEvent): void => {
    if (recordEvent(event, steps, tools)) saw = true;
  };
  let next = first;
  while (!sendSettled) {
    const winner = await Promise.race([
      next.then((result) => ({ kind: "event" as const, result })),
      mark.then(() => ({ kind: "send" as const })),
    ]);
    if (winner.kind === "send") break;
    if (winner.result.done === true) break;
    note(winner.result.value);
    next = iterator.next();
  }
  // Abort rejects `send` while the reactor keeps emitting. Hold this
  // subscription until the turn ends so a late tool cannot be recorded
  // on the next case, where it would also suppress that case's model step.
  let holdForTurn = sendFailed && signal.aborted;
  for (;;) {
    if (holdForTurn) {
      const result = await next;
      if (result.done === true) break;
      note(result.value);
      next = iterator.next();
      if (isTurnEnd(result.value)) holdForTurn = false;
      continue;
    }
    const winner = await nextEventOrIdle(next);
    if (winner.idle) {
      const ready = await takeReady(next);
      if (ready === undefined || ready.done === true) break;
      note(ready.value);
      next = iterator.next();
      continue;
    }
    if (winner.result.done === true) break;
    note(winner.result.value);
    next = iterator.next();
  }
  void next.then(
    () => {},
    () => {},
  );
  return saw;
}

function replyModel(res: AgentSendResult): string {
  if (res.type !== "reply") return "assistant";
  const model = res.turn?.model;
  return typeof model === "string" && model.length > 0 ? model : "assistant";
}

async function sendAgent<O>(
  agent: AgentLike,
  input: string,
  signal: AbortSignal,
): Promise<Trace<O>> {
  if (agent.stream === undefined) {
    const res = await agent.send(input, { signal });
    if (res.type !== "reply") throw new Error(`agent did not reply (got "${res.type}")`);
    return { output: res.reply as O, steps: [] };
  }
  const stream = agent.stream;
  return withAgentLock(agent, async () => {
    if (signal.aborted) throw new Error("run aborted before send");
    const iterator = stream()[Symbol.asyncIterator]();
    const steps: Step[] = [];
    try {
      const first = await discardBuffered(iterator);
      let settled: { ok: true; res: AgentSendResult } | { ok: false; error: unknown } | undefined;
      const pending = agent.send(input, { signal });
      const send = pending.then(
        (res) => {
          settled = { ok: true, res };
        },
        (error: unknown) => {
          settled = { ok: false, error };
        },
      );
      const saw = await collect(iterator, first.pending, steps, pending, signal);
      await send;
      if (settled === undefined || !settled.ok) {
        throw settled === undefined ? new Error("agent send did not settle") : settled.error;
      }
      if (settled.res.type !== "reply") {
        throw new Error(`agent did not reply (got "${settled.res.type}")`);
      }
      if (!saw) {
        steps.push({ name: replyModel(settled.res), kind: "llm", output: settled.res.reply });
      }
      return { output: settled.res.reply as O, steps };
    } finally {
      await iterator.return?.();
    }
  });
}

/**
 * Agents record steps from `stream()` when it exists. Without it, a reply
 * is returned with no steps. A raw workflow definition is refused:
 * running it needs a step invoker, which `workflow()` takes.
 */
export function toTraced<I, O>(
  run: Runnable<I, O>,
  noun = "run",
): (input: I, signal: AbortSignal) => Promise<Trace<O>> {
  if (typeof run === "function") {
    return async (input, signal) => ({ output: await run(input, signal), steps: [] });
  }
  if (typeof run !== "object" || run === null) {
    throw new Error(`${noun} ${NOT_RUNNABLE}`);
  }
  if (TRACE in run) return run[TRACE];
  if ("send" in run && typeof run.send === "function") {
    return async (input, signal) => {
      if (typeof input !== "string") throw new Error("agent input must be a string");
      if (signal.aborted) throw new Error("run aborted before send");
      return sendAgent(run, input, signal);
    };
  }
  if (isWorkflowDefinition(run)) {
    throw new Error(`${noun}: wrap a workflow with workflow() from "@corbits/evals/workflow"`);
  }
  throw new Error(`${noun} ${NOT_RUNNABLE}`);
}
