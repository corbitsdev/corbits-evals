import { describe, expect, test } from "bun:test";

import { EvalFailure, ranSteps, runEvaluation } from "../src/index.js";
import { toTraced, type AgentLike } from "../src/runs.js";

type Event = { type: string; data?: unknown };
type SendResult =
  | { type: "reply"; reply: string; turn?: { model?: string } }
  | { type: "suspended" };

function createStub(options: {
  stream: boolean;
  onSend: (input: string, emit: (event: Event) => void, signal: AbortSignal) => Promise<SendResult>;
}): { agent: AgentLike; maxConsumers: () => number } {
  let consumers = 0;
  let maxConsumers = 0;
  let buffer: Event[] = [{ type: "reactor.start" }];
  const waiters: Array<(result: IteratorResult<Event>) => void> = [];

  function emit(event: Event): void {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter({ value: event, done: false });
    else buffer.push(event);
  }

  const agent: AgentLike = {
    send: (content, opts) =>
      options.onSend(content, emit, opts?.signal ?? new AbortController().signal),
  };
  if (options.stream) {
    agent.stream = () => ({
      [Symbol.asyncIterator](): AsyncIterator<Event> {
        consumers += 1;
        maxConsumers = Math.max(maxConsumers, consumers);
        if (consumers > 1) throw new Error("two consumers");
        return {
          next(): Promise<IteratorResult<Event>> {
            const queued = buffer.shift();
            if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
            return new Promise((resolve) => {
              waiters.push(resolve);
            });
          },
          async return(): Promise<IteratorResult<Event>> {
            consumers -= 1;
            const waiter = waiters.shift();
            if (waiter !== undefined) waiter({ value: undefined, done: true });
            return { value: undefined, done: true };
          },
        };
      },
    });
  }
  return { agent, maxConsumers: () => maxConsumers };
}

async function failure(pending: Promise<unknown>): Promise<EvalFailure> {
  try {
    await pending;
  } catch (cause) {
    if (cause instanceof EvalFailure) return cause;
    throw cause;
  }
  throw new Error("expected runEvaluation to fail");
}

describe("agent trajectory", () => {
  test("a watched tool cycle records llm and tool steps", async () => {
    const { agent } = createStub({
      stream: true,
      onSend: async (input, emit) => {
        emit({
          type: "inference.done",
          data: {
            turn: { model: "stub", content: [{ type: "text", text: "looking" }] },
          },
        });
        emit({
          type: "inference.tool_call.end",
          data: { callId: "c1", name: "search", arguments: { q: input } },
        });
        emit({
          type: "tool.start",
          data: { call: { id: "c1", name: "search", arguments: { q: input } } },
        });
        emit({ type: "tool.update", data: { callId: "c1", partial: "x" } });
        emit({ type: "inference.text.delta", data: { token: "nope" } });
        emit({
          type: "tool.done",
          data: { result: { callId: "orphan", content: "no start" } },
        });
        emit({
          type: "tool.done",
          data: { result: { callId: "c1", content: "found" } },
        });
        emit({
          type: "inference.done",
          data: {
            turn: {
              model: "stub",
              content: [
                { type: "text", text: "done " },
                { type: "thinking", text: "hidden" },
                { type: "text", text: "now" },
              ],
            },
          },
        });
        return { type: "reply", reply: "done now", turn: { model: "stub" } };
      },
    });
    const report = await runEvaluation({
      name: "tool-cycle",
      task: agent,
      data: [{ input: "order" }],
      scorers: { ran: ranSteps(["search"]), none: ranSteps([]) },
      allow: { none: 1 },
    });
    expect(report.cases[0]?.steps).toEqual([
      { name: "stub", kind: "llm", output: "looking" },
      { name: "search", kind: "tool", input: { q: "order" }, output: "found" },
      { name: "stub", kind: "llm", output: "done now" },
    ]);
    expect(report.cases[0]?.checks["ran"]?.pass).toBe(true);
    expect(report.cases[0]?.checks["none"]?.pass).toBe(false);
  });

  test("a watched reply with no inference or tool is one llm step", async () => {
    const { agent } = createStub({
      stream: true,
      onSend: async () => ({ type: "reply", reply: "hello", turn: { model: "stub-model" } }),
    });
    const report = await runEvaluation({
      name: "reply-only-watched",
      task: agent,
      data: [{ input: "hi" }],
      scorers: { none: ranSteps([]), search: ranSteps(["search"]) },
      allow: { search: 1 },
    });
    expect(report.cases[0]?.steps).toEqual([{ name: "stub-model", kind: "llm", output: "hello" }]);
    expect(report.cases[0]?.checks["none"]?.pass).toBe(true);
    expect(report.cases[0]?.checks["search"]?.pass).toBe(false);
  });

  test("a watched reply without a model name is assistant", async () => {
    const { agent } = createStub({
      stream: true,
      onSend: async () => ({ type: "reply", reply: "hello" }),
    });
    const report = await runEvaluation({
      name: "reply-only-assistant",
      task: agent,
      data: [{ input: "hi" }],
      scorers: { none: ranSteps([]) },
    });
    expect(report.cases[0]?.steps).toEqual([{ name: "assistant", kind: "llm", output: "hello" }]);
  });

  test("send without stream leaves steps empty and ranSteps([]) fails", async () => {
    const { agent } = createStub({
      stream: false,
      onSend: async () => ({ type: "reply", reply: "hello", turn: { model: "stub" } }),
    });
    const err = await failure(
      runEvaluation({
        name: "send-only",
        task: agent,
        data: [{ input: "hi" }],
        scorers: { none: ranSteps([]) },
      }),
    );
    expect(err.report.cases[0]?.steps).toEqual([]);
    expect(err.report.cases[0]?.checks["none"]).toMatchObject({
      pass: false,
      value: 0,
      explanation: "an empty step list is not an observed empty tool path",
    });
  });

  test("a suspended send still fails the case", async () => {
    const { agent } = createStub({
      stream: false,
      onSend: async () => ({ type: "suspended" }),
    });
    const err = await failure(
      runEvaluation({
        name: "suspended",
        task: agent,
        data: [{ input: "hi", expectedOutput: "hi" }],
      }),
    );
    expect(err.report.cases[0]?.error).toBe('agent did not reply (got "suspended")');
  });

  test("overlapping cases on one agent do not mix steps", async () => {
    const { agent, maxConsumers } = createStub({
      stream: true,
      onSend: async (input, emit) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        emit({
          type: "inference.done",
          data: { turn: { model: "stub", content: [{ type: "text", text: input }] } },
        });
        emit({
          type: "tool.start",
          data: { call: { id: input, name: input, arguments: { q: input } } },
        });
        emit({
          type: "tool.done",
          data: { result: { callId: input, content: input } },
        });
        return { type: "reply", reply: input, turn: { model: "stub" } };
      },
    });
    const report = await runEvaluation({
      name: "overlap",
      task: agent,
      concurrency: 2,
      data: [
        { name: "a", input: "search" },
        { name: "b", input: "lookup" },
      ],
      scorers: { ran: ranSteps([]) },
      allow: { ran: 2 },
    });
    const byName = Object.fromEntries(
      report.cases.map((c) => [c.name, c.steps.map((s) => s.name)]),
    );
    expect(byName).toEqual({
      a: ["stub", "search"],
      b: ["stub", "lookup"],
    });
    expect(maxConsumers()).toBe(1);
  });

  test("a reply inference.done emitted after send still lands", async () => {
    const { agent } = createStub({
      stream: true,
      onSend: async (_input, emit) => {
        emit({
          type: "tool.start",
          data: { call: { id: "c1", name: "search", arguments: { q: "late" } } },
        });
        emit({
          type: "tool.done",
          data: { result: { callId: "c1", content: "found" } },
        });
        setTimeout(() => {
          emit({
            type: "inference.done",
            data: {
              turn: { model: "reply-model", content: [{ type: "text", text: "from-stream" }] },
            },
          });
        }, 0);
        return { type: "reply", reply: "from-send", turn: { model: "send-model" } };
      },
    });
    const report = await runEvaluation({
      name: "late-inference",
      task: agent,
      data: [{ input: "late" }],
      scorers: { ran: ranSteps(["search"]) },
    });
    expect(report.cases[0]?.steps).toEqual([
      { name: "search", kind: "tool", input: { q: "late" }, output: "found" },
      { name: "reply-model", kind: "llm", output: "from-stream" },
    ]);
  });

  test("an aborted waiter does not send", async () => {
    let sends = 0;
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const { agent } = createStub({
      stream: true,
      onSend: async () => {
        sends += 1;
        await gate;
        return { type: "reply", reply: "a", turn: { model: "stub" } };
      },
    });
    const run = toTraced(agent);
    const inFlight = new AbortController();
    const queued = new AbortController();
    const pendingA = run("a", inFlight.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pendingB = run("b", queued.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    queued.abort();
    releaseA();
    await pendingA;
    await expect(pendingB).rejects.toThrow("run aborted before send");
    expect(sends).toBe(1);
  });

  test("an aborted turn's late tool does not land on the next case", async () => {
    const { agent } = createStub({
      stream: true,
      onSend: (input, emit, signal) => {
        if (input !== "slow") {
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve({ type: "reply", reply: "found", turn: { model: "stub" } });
            }, 80);
          });
        }
        return new Promise((_resolve, reject) => {
          const abort = (): void => {
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
            setTimeout(() => {
              emit({
                type: "tool.start",
                data: { call: { id: "late", name: "search", arguments: { q: "slow" } } },
              });
              emit({ type: "connector.reply", data: { content: "late" } });
            }, 30);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    });
    const err = await failure(
      runEvaluation({
        name: "abort-then-lookup",
        task: agent,
        concurrency: 1,
        timeout: 200,
        data: [
          { name: "slow", input: "slow" },
          { name: "lookup", input: "lookup" },
        ],
        scorers: { none: ranSteps([]), search: ranSteps(["search"]) },
      }),
    );
    const lookup = err.report.cases.find((c) => c.name === "lookup");
    expect(err.report.cases[0]?.error).toContain("timed out");
    expect(lookup?.error).toBeUndefined();
    expect(lookup?.steps).toEqual([{ name: "stub", kind: "llm", output: "found" }]);
    expect(lookup?.checks["none"]?.pass).toBe(true);
    expect(lookup?.checks["search"]?.pass).toBe(false);
  });

  test("a policy deny records the tool name without tool.start", async () => {
    const { agent } = createStub({
      stream: true,
      onSend: async (input, emit) => {
        if (input === "from-block") {
          emit({
            type: "inference.done",
            data: {
              turn: {
                model: "stub",
                content: [
                  { type: "text", text: "no" },
                  { type: "tool_call", id: "c1", name: "search", arguments: { q: input } },
                ],
              },
            },
          });
        } else {
          emit({
            type: "inference.done",
            data: { turn: { model: "stub", content: [{ type: "text", text: "no" }] } },
          });
          emit({
            type: "inference.tool_call.end",
            data: { callId: "c1", name: "search", arguments: { q: input } },
          });
          emit({
            type: "inference.tool_call.end",
            data: { callId: "empty", name: "", arguments: {} },
          });
        }
        emit({
          type: "tool.done",
          data: { result: { callId: "nameless", content: "no name" } },
        });
        emit({
          type: "tool.done",
          data: { result: { callId: "empty", content: "skip" } },
        });
        emit({
          type: "tool.done",
          data: { result: { callId: "c1", content: "blocked", isError: true } },
        });
        return { type: "reply", reply: "no", turn: { model: "stub" } };
      },
    });
    const report = await runEvaluation({
      name: "policy-deny",
      task: agent,
      data: [
        { name: "from-end", input: "from-end" },
        { name: "from-block", input: "from-block" },
      ],
      scorers: { ran: ranSteps(["search"]), none: ranSteps([]) },
      allow: { none: 2 },
    });
    for (const evalCase of report.cases) {
      expect(evalCase.steps).toEqual([
        { name: "stub", kind: "llm", output: "no" },
        { name: "search", kind: "tool", input: { q: evalCase.input }, output: "blocked" },
      ]);
      expect(evalCase.checks["ran"]?.pass).toBe(true);
      expect(evalCase.checks["none"]?.pass).toBe(false);
    }
  });
});
