// Shared local-Ollama wiring for the examples. The judge is a workflow step;
// this file's invoker turns the step input into a Jev reply. No provider SDK.
import { defineAgent } from "@intx/agent";
import { step } from "@intx/workflow";

import { judgeModel } from "../src/workflow.js";

const JUDGE_URL = "http://localhost:11434/api/chat";

export const localJev = judgeModel({
  model: step({
    agent: defineAgent({
      id: "local-jev",
      systemPrompt: "Answer the Jev questions in the input.",
      tools: [],
      capabilities: [],
      inference: { sources: [{ provider: "ollama", model: "clef-flash:9b" }] },
    }),
  }),
  timeout: "180s",
  invokeStep: async ({ input, agent }) => {
    const model = agent.inference.sources[0]?.model ?? "clef-flash:9b";
    const res = await fetch(JUDGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "user",
            content: `Reply with JSON {"decisions":[...]} for this Jev payload:\n${JSON.stringify(input)}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      return { output: { fallback: true, reason: "http-error", detail: `HTTP ${res.status}` } };
    }
    const data = (await res.json()) as { message?: { content?: unknown } };
    const content = data.message?.content;
    if (typeof content !== "string") {
      return { output: { fallback: true, reason: "parse-error", detail: "no reply text" } };
    }
    try {
      return { output: JSON.parse(content) as unknown };
    } catch (cause) {
      return {
        output: {
          fallback: true,
          reason: "parse-error",
          detail: cause instanceof Error ? cause.message : String(cause),
        },
      };
    }
  },
});

export async function ollamaGenerate(model: string, prompt: string): Promise<string> {
  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`ollama generate HTTP ${res.status}`);
  const data = (await res.json()) as { response?: unknown };
  if (typeof data.response !== "string") throw new Error("ollama generate: no response text");
  return data.response;
}
