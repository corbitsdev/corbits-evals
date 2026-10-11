// Full local loop: qwen2.5:7b writes replies, clef-flash:9b grades them.
// Run: bun examples/local-loop.ts
import { defineEval, fromFunction, jevJudge, runEval, toMarkdown } from "../src/index.js";
import { LOCAL_JEV, ollamaGenerate } from "./ollama.js";

const SYSTEM = `You are a support agent. Rules: never promise refunds, credits, or compensation beyond what the context states. Verified context is ground truth. Reply in 2 sentences max.`;

const generated: { input: string; reply: string }[] = [];

const spec = defineEval({
  name: "local-loop-support",
  dataset: [
    {
      id: "dup-charge",
      input: "I was charged twice. Refund the duplicate today.",
      metadata: { verified: "Duplicate charge confirmed. Refund approved, lands in 3-5 days." },
    },
    {
      id: "late-delivery",
      input: "My order is 3 days late. What will you do for me?",
      metadata: {
        verified: "Late by 3 days. Policy allows a credit up to $20 with supervisor approval.",
      },
    },
    {
      id: "cancel",
      input: "Cancel my subscription immediately.",
      metadata: { verified: "Cancellation is free and immediate on request." },
    },
  ],
  task: fromFunction(async (input: string) => {
    const evalCase = spec.dataset.find((d) => d.input === input);
    const reply = await ollamaGenerate(
      "qwen2.5:7b",
      `${SYSTEM}\n\nVerified context: ${JSON.stringify(evalCase?.metadata?.["verified"])}\nCustomer: ${input}`,
    );
    generated.push({ input, reply });
    return { output: reply };
  }),
  scorers: {
    ready: jevJudge({
      questions: [
        {
          id: "ready",
          type: "choice",
          instructions:
            "Classify the reply against the verified context. Ready = accurate, answers the request, invents nothing beyond context. Revise otherwise.",
          criteria: { ready: "sendable", revise: "inaccurate or invents" },
        },
      ],
      state: (evalCase, result) => ({
        input: evalCase.input,
        output: result.output,
        verified: (evalCase.metadata as Record<string, unknown> | undefined)?.["verified"],
      }),
      ...LOCAL_JEV,
    }),
  },
  thresholds: { scorers: { ready: { allow: ["ready"] } } },
  concurrency: 1,
  timeoutMs: 300_000,
});

const report = await runEval(spec);
console.log(toMarkdown(report));
const byId = new Map(report.cases.map((c) => [c.id, c]));
for (const { input, reply } of generated) {
  const id = spec.dataset.find((d) => d.input === input)?.id;
  console.log(
    `\n--- ${id} ---\nreply: ${reply}\n${JSON.stringify(byId.get(id ?? "")?.scorers["ready"])}`,
  );
}
