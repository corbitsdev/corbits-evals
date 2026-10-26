// ABCDE factuality rubric: A, B, C and E count as factual, D does not.
// Agreement vs ground truth is the metric; exact match is the baseline.
// Run: bun examples/ports/factuality.ts
import { ask, runEvaluation, matches } from "../../src/index.js";
import { localJev } from "../ollama.js";

const CRITERIA = {
  A: "subset of the expert answer and fully consistent with it",
  B: "superset of the expert answer and fully consistent with it",
  C: "contains all the same details as the expert answer",
  D: "disagrees with the expert answer",
  E: "differs, but immaterially from the perspective of factuality",
};

type Truth = { option: keyof typeof CRITERIA; pass: boolean };

const CASES: { id: string; question: string; expert: string; submission: string; truth: Truth }[] =
  [
    {
      id: "same",
      question: "What is the capital of France?",
      expert: "Paris is the capital of France.",
      submission: "The capital of France is Paris.",
      truth: { option: "C", pass: true },
    },
    {
      id: "subset",
      question: "Summarize the refund policy.",
      expert: "Refunds are issued within 30 days, require a receipt, and exclude final-sale items.",
      submission: "Refunds are issued within 30 days.",
      truth: { option: "A", pass: true },
    },
    {
      id: "superset",
      question: "When does the store open?",
      expert: "The store opens at 9am.",
      submission: "The store opens at 9am on weekdays.",
      truth: { option: "B", pass: true },
    },
    {
      id: "disagree",
      question: "How long does delivery take?",
      expert: "Delivery takes 3 to 5 business days.",
      submission: "Delivery takes 7 business days.",
      truth: { option: "D", pass: false },
    },
    {
      id: "immaterial",
      question: "Is the API down?",
      expert: "Yes, the API is currently down for maintenance.",
      submission: "Yep — API's down for maintenance right now.",
      truth: { option: "E", pass: true },
    },
    {
      id: "paraphrase",
      question: "Who wrote Hamlet?",
      expert: "William Shakespeare wrote Hamlet.",
      submission: "Hamlet was authored by Shakespeare.",
      truth: { option: "C", pass: true },
    },
    {
      id: "invented",
      question: "What is the credit limit?",
      expert: "Credit is available up to $20 with approval.",
      submission: "Credit up to $20 with approval, plus a $50 bonus automatically.",
      truth: { option: "D", pass: false },
    },
    {
      id: "contradict",
      question: "Is cancellation free?",
      expert: "Cancellation is free and immediate.",
      submission: "Cancellation costs $10 and takes a week.",
      truth: { option: "D", pass: false },
    },
  ];

const report = await runEvaluation({
  name: "port-factuality",
  task: (question: string) => CASES.find((c) => c.question === question)?.submission ?? "",
  data: CASES.map((c) => ({ name: c.id, input: c.question, expectedOutput: c.expert })),
  scorers: {
    baseline_exact: matches(),
    jev_factuality: ask(
      "Compare the factual content of the output with the expert answer in expectedOutput. Ignore style, grammar, punctuation. Pick one option.",
      { options: CRITERIA, pass: ["A", "B", "C", "E"] },
    ),
  },
  allow: { baseline_exact: CASES.length, jev_factuality: CASES.length },
  judge: localJev,
});
console.log(report.markdown());

let baselineAgree = 0;
let jevAgree = 0;
let jevOption = 0;
for (const c of report.cases) {
  const truth = CASES.find((t) => t.id === c.name)?.truth;
  if (!truth) continue;
  if ((c.checks["baseline_exact"]?.pass ?? false) === truth.pass) baselineAgree += 1;
  const jv = c.checks["jev_factuality"];
  if ((jv?.pass ?? false) === truth.pass) jevAgree += 1;
  if (jv?.label === truth.option) jevOption += 1;
}
console.log(`\nagreement with ground truth over ${CASES.length} cases:`);
console.log(`- baseline exact match pass/fail: ${baselineAgree}/${CASES.length}`);
console.log(`- jev factuality pass/fail:       ${jevAgree}/${CASES.length}`);
console.log(`- jev exact ABCDE option:          ${jevOption}/${CASES.length}`);
