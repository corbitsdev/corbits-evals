// ABCDE factuality rubric with graded scores (A:.4 B:.6 C:1 D:0 E:1).
// Agreement vs ground truth is the metric; exactMatch is the baseline.
// Run: bun examples/ports/factuality.ts
import { defineEval, exactMatch, jevJudge, runEval, toMarkdown } from "../../src/index.js";
import { LOCAL_JEV } from "../ollama.js";

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

const factuality = jevJudge<string, string>({
  questions: [
    {
      id: "fact",
      type: "choice",
      instructions:
        "Compare the factual content of the submitted answer with the expert answer. Ignore style, grammar, punctuation. Pick one option.",
      criteria: CRITERIA,
    },
  ],
  scores: { fact: { A: 0.4, B: 0.6, C: 1, D: 0, E: 1 } },
  state: (kase, result) => ({
    question: kase.input,
    expert: kase.expected,
    submission: result.output,
  }),
  ...LOCAL_JEV,
});

const spec = defineEval({
  name: "port-factuality",
  dataset: CASES.map((c) => ({ id: c.id, input: c.question, expected: c.expert })),
  task: async (input) => {
    const found = CASES.find((c) => c.question === input);
    if (!found) throw new Error("unknown case");
    return { output: found.submission };
  },
  scorers: { baseline_exact: exactMatch(), jev_factuality: factuality },
  // A/B/C/E (>= .4) count as factual; D (0) does not.
  thresholds: { scorers: { jev_factuality: { min: 0.4 } } },
});

const report = await runEval(spec);
console.log(toMarkdown(report));

let baselineAgree = 0;
let jevAgree = 0;
let jevOption = 0;
for (const c of report.cases) {
  const truth = CASES.find((t) => t.id === c.id)?.truth;
  if (!truth) continue;
  if ((c.scorers["baseline_exact"]?.pass ?? false) === truth.pass) baselineAgree += 1;
  const jv = c.scorers["jev_factuality"];
  if ((jv?.pass ?? false) === truth.pass) jevAgree += 1;
  if (jv?.label === truth.option) jevOption += 1;
}
console.log(`\nagreement with ground truth over ${CASES.length} cases:`);
console.log(`- baseline exactMatch pass/fail: ${baselineAgree}/${CASES.length}`);
console.log(`- jev factuality pass/fail:      ${jevAgree}/${CASES.length}`);
console.log(`- jev exact ABCDE option:         ${jevOption}/${CASES.length}`);
