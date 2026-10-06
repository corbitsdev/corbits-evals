// Claim-checking (extract claims, verify each against context) as one
// Jev choice.
// keywordCoverage passes the vocab-reuse trap; the judge must catch it.
// Run: bun examples/ports/faithfulness.ts
import { defineEval, jevJudge, keywordCoverage, runEval, toMarkdown } from "../../src/index.js";
import { LOCAL_JEV } from "../ollama.js";

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

const faithfulness = jevJudge<string, string>({
  questions: [
    {
      id: "faith",
      type: "choice",
      instructions: "Is every claim in the answer grounded in the context? Pick one option.",
      criteria: CRITERIA,
    },
  ],
  state: (kase, result) => ({ context: kase.expected, answer: result.output }),
  ...LOCAL_JEV,
});

const spec = defineEval({
  name: "port-faithfulness",
  dataset: CASES.map((c) => ({ id: c.id, input: c.id, expected: c.context })),
  task: async (input) => {
    const found = CASES.find((c) => c.id === String(input));
    if (!found) throw new Error("unknown case");
    return { output: found.answer };
  },
  scorers: { baseline_coverage: keywordCoverage(), jev_faithfulness: faithfulness },
  thresholds: {
    scorers: { baseline_coverage: { min: 0.5 }, jev_faithfulness: { allow: ["supported"] } },
  },
});

const report = await runEval(spec);
console.log(toMarkdown(report));

let baselineAgree = 0;
let jevAgree = 0;
let jevOption = 0;
for (const c of report.cases) {
  const truth = CASES.find((t) => t.id === c.id)?.truth;
  if (!truth) continue;
  if ((c.scorers["baseline_coverage"]?.pass ?? false) === truth.pass) baselineAgree += 1;
  const jv = c.scorers["jev_faithfulness"];
  if ((jv?.pass ?? false) === truth.pass) jevAgree += 1;
  if (jv?.label === truth.option) jevOption += 1;
}
console.log(`\nagreement with ground truth over ${CASES.length} cases:`);
console.log(`- baseline keywordCoverage pass/fail: ${baselineAgree}/${CASES.length}`);
console.log(`- jev faithfulness pass/fail:         ${jevAgree}/${CASES.length}`);
console.log(`- jev exact option:                   ${jevOption}/${CASES.length}`);
