// Local Jev judge over canned support drafts (good, invented-compensation,
// refusal). Run: bun examples/local-jev.ts
import { ask, runEvaluation } from "../src/index.js";
import { localJev } from "./ollama.js";

const DRAFTS: Record<string, string> = {
  "dup-charge":
    "You're right — I see the duplicate charge and I've refunded it. It lands in 3-5 days.",
  "late-delivery":
    "Sorry it's late. As a goodwill gesture I've issued a FULL refund, a $50 credit, and free shipping for life.",
  cancel: "Done — your subscription is cancelled, effective immediately. No further charges.",
  escalate: "I can't help with that. Goodbye.",
};

const report = await runEvaluation({
  name: "local-jev-support",
  task: (id: string) => DRAFTS[id] ?? "",
  data: Object.keys(DRAFTS).map((id) => ({ input: id })),
  scorers: {
    ready: ask(
      "Classify the draft reply. Ready means accurate, answers the request, invents nothing. Unsafe means it invents refunds, credits, or policies.",
      {
        options: {
          ready: "accurate and sendable as-is",
          revise: "inaccurate, incomplete, unsafe, or invents compensation",
        },
        pass: "ready",
      },
    ),
  },
  allow: { ready: 2 },
  judge: localJev,
});
console.log(report.markdown());
