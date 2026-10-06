// Keyword overlap: exactMatch fails every paraphrase; coverage passes
// them. Run: bun examples/ports/keyword-coverage.ts
import { defineEval, exactMatch, keywordCoverage, runEval, toMarkdown } from "../../src/index.js";

const CASES: { id: string; question: string; reference: string; output: string; truth: boolean }[] =
  [
    {
      id: "paraphrase",
      question: "Capital of France?",
      reference: "Paris is the capital of France",
      output: "France's capital city is Paris",
      truth: true,
    },
    {
      id: "reorder",
      question: "Refund window?",
      reference: "Refunds issued within thirty days with receipt",
      output: "With a receipt, refunds are issued within 30 days", // note: 30 vs thirty
      truth: true,
    },
    {
      id: "unrelated",
      question: "Capital of France?",
      reference: "Paris is the capital of France",
      output: "Penguins swim in cold water",
      truth: false,
    },
    {
      id: "partial",
      question: "Policy?",
      reference: "Refunds require receipt approval manager signature",
      output: "Refunds need extra paperwork",
      truth: false, // 1/6 keywords: below coverage by construction
    },
    {
      id: "same-words-new-meaning",
      question: "Delivery?",
      reference: "Delivery takes three to five business days",
      output: "Delivery does not take three to five business days",
      truth: true, // coverage passes on words; documents the blind spot judges must cover
    },
  ];

const spec = defineEval({
  name: "port-keyword-coverage",
  dataset: CASES.map((c) => ({ id: c.id, input: c.id, expected: c.reference })),
  task: async (input) => {
    const found = CASES.find((c) => c.id === String(input));
    if (!found) throw new Error("unknown case");
    return { output: found.output };
  },
  scorers: { baseline_exact: exactMatch(), port_coverage: keywordCoverage() },
  thresholds: { scorers: { port_coverage: { min: 0.5 } } },
});

const report = await runEval(spec);
console.log(toMarkdown(report));

let baselineAgree = 0;
let portAgree = 0;
for (const c of report.cases) {
  const truth = CASES.find((t) => t.id === c.id)?.truth;
  if (truth === undefined) continue;
  if ((c.scorers["baseline_exact"]?.pass ?? false) === truth) baselineAgree += 1;
  if ((c.scorers["port_coverage"]?.pass ?? false) === truth) portAgree += 1;
}
console.log(`\nagreement with ground truth over ${CASES.length} cases:`);
console.log(`- baseline exactMatch: ${baselineAgree}/${CASES.length}`);
console.log(`- port keywordCoverage: ${portAgree}/${CASES.length}`);
