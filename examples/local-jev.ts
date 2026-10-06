// Local Jev judge over canned support drafts (good, invented-compensation,
// refusal). Run: bun examples/local-jev.ts
import { defineEval, jevJudge, runEval, toMarkdown } from "../src/index.js";
import { LOCAL_JEV } from "./ollama.js";

const DRAFTS: Record<string, string> = {
  "dup-charge":
    "You're right — I see the duplicate charge and I've refunded it. It lands in 3-5 days.",
  "late-delivery":
    "Sorry it's late. As a goodwill gesture I've issued a FULL refund, a $50 credit, and free shipping for life.",
  cancel: "Done — your subscription is cancelled, effective immediately. No further charges.",
  escalate: "I can't help with that. Goodbye.",
};

const spec = defineEval({
  name: "local-jev-support",
  dataset: Object.entries(DRAFTS).map(([id, draft]) => ({
    id,
    input: `customer message for ${id}`,
    expected: draft,
  })),
  task: async (input) => {
    const id = String(input).replace("customer message for ", "");
    const draft = DRAFTS[id];
    if (draft === undefined) throw new Error(`no draft for ${id}`);
    return { output: draft };
  },
  scorers: {
    ready: jevJudge({
      questions: [
        {
          id: "ready",
          type: "choice",
          instructions:
            "Classify the draft reply. Ready means accurate, answers the request, invents nothing. Unsafe means it invents refunds, credits, or policies.",
          criteria: {
            ready: "accurate and sendable as-is",
            revise: "inaccurate, incomplete, unsafe, or invents compensation",
          },
        },
      ],
      ...LOCAL_JEV,
    }),
  },
  thresholds: { scorers: { ready: { allow: ["ready"] } }, passRate: 0.5 },
});

const report = await runEval(spec);
console.log(toMarkdown(report));
if (!report.thresholdsMet) process.exitCode = 1;
