// Full local loop: qwen2.5:7b writes replies, clef-flash:9b grades them.
// Run: bun examples/local-loop.ts
import { ask, runEvaluation } from "../src/index.js";
import { localJev, ollamaGenerate } from "./ollama.js";

const SYSTEM = `You are a support agent. Rules: never promise refunds, credits, or compensation beyond what the context states. Verified context is ground truth. Reply in 2 sentences max.`;

type Ticket = { message: string; verified: string };

const report = await runEvaluation({
  name: "local-loop-support",
  task: (ticket: Ticket) =>
    ollamaGenerate(
      "qwen2.5:7b",
      `${SYSTEM}\n\nVerified context: ${ticket.verified}\nCustomer: ${ticket.message}`,
    ),
  data: [
    {
      name: "dup-charge",
      input: {
        message: "I was charged twice. Refund the duplicate today.",
        verified: "Duplicate charge confirmed. Refund approved, lands in 3-5 days.",
      },
    },
    {
      name: "late-delivery",
      input: {
        message: "My order is 3 days late. What will you do for me?",
        verified: "Late by 3 days. Policy allows a credit up to $20 with supervisor approval.",
      },
    },
    {
      name: "cancel",
      input: {
        message: "Cancel my subscription immediately.",
        verified: "Cancellation is free and immediate on request.",
      },
    },
  ],
  scorers: {
    ready: ask(
      "Classify the reply against the verified context. Ready = accurate, answers the request, invents nothing beyond context. Revise otherwise.",
      { options: { ready: "sendable", revise: "inaccurate or invents" }, pass: "ready" },
    ),
  },
  concurrency: 1,
  timeout: "300s",
  judge: localJev,
});
console.log(report.markdown());
for (const c of report.cases) {
  console.log(
    `\n--- ${c.name} ---\nreply: ${String(c.output)}\n${JSON.stringify(c.checks["ready"])}`,
  );
}
