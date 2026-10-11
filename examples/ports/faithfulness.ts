// Claim-checking (extract claims, verify each against context) as one
// Jev choice. Keyword coverage passes the vocab-reuse trap; the judge
// must catch it. Run: bun examples/ports/faithfulness.ts
import { ask, evaluate } from "../../src/index.js";
import { localJev } from "../ollama.js";
import { coverage } from "../words.js";

const CRITERIA = {
  supported: "every claim in the answer is supported by the context",
  contradicted: "the answer contradicts the context",
  unverifiable: "the answer adds claims the context neither supports nor contradicts",
};

type Truth = { option: keyof typeof CRITERIA; pass: boolean };

const CASES: { id: string; context: string; answer: string; truth: Truth }[] = [
  {
    id: "grounded",
    context: "Refunds are issued within 30 days with a receipt.",
    answer: "You can get a refund within 30 days if you have the receipt.",
    truth: { option: "supported", pass: true },
  },
  {
    id: "negation-trap",
    context: "Delivery takes three to five business days.",
    answer: "Delivery does not take three to five business days.",
    truth: { option: "contradicted", pass: false },
  },
  {
    id: "invented-policy",
    context: "Credit up to $20 with supervisor approval.",
    answer: "Credit up to $20 with approval, plus an automatic $50 bonus.",
    truth: { option: "contradicted", pass: false },
  },
  {
    id: "extra-true",
    context: "The store opens at 9am.",
    answer: "The store opens at 9am, and the sky is blue.",
    truth: { option: "unverifiable", pass: false },
  },
  {
    id: "paraphrase",
    context: "Cancellation is free and immediate on request.",
    answer: "On request, cancelling costs nothing and happens right away.",
    truth: { option: "supported", pass: true },
  },
  {
    id: "wrong-number",
    context: "The limit is $20.",
    answer: "The limit is $200.",
    truth: { option: "contradicted", pass: false },
  },
];

// The context goes in as the input, so Jev sees it next to the answer.
const report = await evaluate("port-faithfulness", {
  run: (context: string) => CASES.find((c) => c.context === context)?.answer ?? "",
  cases: CASES.map((c) => ({ name: c.id, input: c.context })),
  checks: {
    baseline_coverage: (r) => coverage(r.input, r.output) >= 0.5,
    jev_faithfulness: ask(
      "Is every claim in the output grounded in the context given as input? Pick one option.",
      { options: CRITERIA, pass: "supported" },
    ),
  },
  allow: { baseline_coverage: CASES.length, jev_faithfulness: CASES.length },
  judge: localJev,
});
console.log(report.markdown());

let baselineAgree = 0;
let jevAgree = 0;
let jevOption = 0;
for (const c of report.cases) {
  const truth = CASES.find((t) => t.id === c.name)?.truth;
  if (!truth) continue;
  if ((c.checks["baseline_coverage"]?.pass ?? false) === truth.pass) baselineAgree += 1;
  const jv = c.checks["jev_faithfulness"];
  if ((jv?.pass ?? false) === truth.pass) jevAgree += 1;
  if (jv?.label === truth.option) jevOption += 1;
}
console.log(`\nagreement with ground truth over ${CASES.length} cases:`);
console.log(`- baseline keyword coverage pass/fail: ${baselineAgree}/${CASES.length}`);
console.log(`- jev faithfulness pass/fail:          ${jevAgree}/${CASES.length}`);
console.log(`- jev exact option:                    ${jevOption}/${CASES.length}`);
