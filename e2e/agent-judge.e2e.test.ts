import { describe, expect, test } from "bun:test";
import type { ConversationTurn } from "@intx/types/runtime";

import { agentJudge, senderFromIntxAgent } from "../src/agentJudge.js";
import { booleanResult } from "../src/results.js";

const turn = {} as ConversationTurn;

describe("agentJudge", () => {
  test("grades via an @intx/agent sender", async () => {
    const prompts: string[] = [];
    const fake = {
      send: async (prompt: string) => {
        prompts.push(prompt);
        return { type: "reply" as const, reply: "PASS: answers fully", turn };
      },
    };
    const judge = agentJudge({
      instructions: "Reply PASS or FAIL.",
      send: senderFromIntxAgent(fake),
      parse: (reply) => ({ result: booleanResult(reply.startsWith("PASS")), explanation: reply }),
    });
    const verdict = await judge({
      evalCase: { id: "a", input: "refund?", expected: "yes" },
      result: { output: "yes" },
    });
    expect(verdict.result).toEqual(booleanResult(true));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("<input>");
    expect(prompts[0]).toContain("refund?");
  });

  test("sender failure fails closed", async () => {
    const judge = agentJudge({
      instructions: "Reply PASS or FAIL.",
      send: async () => {
        throw new Error("no route");
      },
      parse: () => ({ result: booleanResult(true) }),
    });
    const verdict = await judge({ evalCase: { id: "b", input: "x" }, result: { output: "y" } });
    expect(verdict.result).toEqual({ kind: "score", value: 0 });
    expect(verdict.explanation).toContain("no route");
  });

  test("a hung sender times out", async () => {
    const judge = agentJudge({
      instructions: "x",
      send: () => new Promise(() => {}),
      parse: () => ({ result: booleanResult(true) }),
      timeoutMs: 30,
    });
    const verdict = await judge({ evalCase: { id: "c", input: "x" }, result: { output: "y" } });
    expect(verdict.explanation).toContain("timed out");
  });
});
