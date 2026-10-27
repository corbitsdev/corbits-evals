// Keyword overlap: exact match fails every paraphrase; coverage passes
// them. Run: bun examples/ports/keyword-coverage.ts
import { runEvaluation, matches } from "../../src/index.js";
import { coverage } from "../words.js";

const CASES: { id: string; reference: string; output: string; truth: boolean }[] = [
  {
    id: "paraphrase",
    reference: "Paris is the capital of France",
    output: "France's capital city is Paris",
    truth: true,
  },
  {
    id: "reorder",
    reference: "Refunds issued within thirty days with receipt",
    output: "With a receipt, refunds are issued within 30 days", // note: 30 vs thirty
    truth: true,
  },
  {
    id: "unrelated",
    reference: "Paris is the capital of France",
    output: "Penguins swim in cold water",
    truth: false,
  },
  {
    id: "partial",
    reference: "Refunds require receipt approval manager signature",
    output: "Refunds need extra paperwork",
    truth: false, // 1/6 keywords: below coverage by construction
  },
  {
    id: "same-words-new-meaning",
    reference: "Delivery takes three to five business days",
    output: "Delivery does not take three to five business days",
    truth: true, // coverage passes on words; documents the blind spot judges must cover
  },
];

const report = await runEvaluation({
  name: "port-keyword-coverage",
  task: (id: string) => CASES.find((c) => c.id === id)?.output ?? "",
  data: CASES.map((c) => ({ input: c.id, expectedOutput: c.reference })),
  scorers: {
    baseline_exact: matches(),
    port_coverage: (r) => coverage(r.expectedOutput ?? "", r.output) >= 0.5,
  },
  allow: { baseline_exact: CASES.length, port_coverage: CASES.length },
});
console.log(report.markdown());

let baselineAgree = 0;
let portAgree = 0;
for (const c of report.cases) {
  const truth = CASES.find((t) => t.id === c.name)?.truth;
  if (truth === undefined) continue;
  if ((c.checks["baseline_exact"]?.pass ?? false) === truth) baselineAgree += 1;
  if ((c.checks["port_coverage"]?.pass ?? false) === truth) portAgree += 1;
}
console.log(`\nagreement with ground truth over ${CASES.length} cases:`);
console.log(`- baseline exact match: ${baselineAgree}/${CASES.length}`);
console.log(`- port keyword coverage: ${portAgree}/${CASES.length}`);
