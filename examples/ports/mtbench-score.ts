// 1-10 helpfulness as a Jev score question. Rank order of four answers
// is the ground truth. Run: bun examples/ports/mtbench-score.ts
import { defineEval, jevJudge, runEval, toMarkdown } from "../../src/index.js";
import { LOCAL_JEV } from "../ollama.js";

const LEVELS = [
  "1: useless or wrong",
  "2: mostly wrong",
  "3: major errors",
  "4: partially helpful",
  "5: adequate",
  "6: good",
  "7: very good",
  "8: excellent",
  "9: outstanding",
  "10: perfect",
];

const QUESTION = "What is the capital of France?";

const CASES: { id: string; rank: number; answer: string }[] = [
  { id: "best", rank: 1, answer: "Paris is the capital of France, confirmed by every atlas." },
  { id: "good", rank: 2, answer: "The capital of France is Paris." },
  { id: "thin", rank: 3, answer: "Paris." },
  { id: "wrong", rank: 4, answer: "The capital of France is Lyon, a lovely city." },
];

const helpfulness = jevJudge<string, string>({
  questions: [
    {
      id: "help",
      type: "score",
      instructions:
        "Rate the answer's helpfulness and correctness. A bare fragment with no explanation caps at 5. A complete correct answer with supporting detail scores 8+. A wrong answer scores 1-2.",
      criteria: LEVELS,
    },
  ],
  state: (evalCase, result) => ({ question: QUESTION, answer: result.output }),
  ...LOCAL_JEV,
});

const spec = defineEval({
  name: "port-mtbench-score",
  dataset: CASES.map((c) => ({ id: c.id, input: c.id, expected: "ranked answer" })),
  task: async (input) => {
    const found = CASES.find((c) => c.id === String(input));
    if (!found) throw new Error("unknown case");
    return { output: found.answer };
  },
  scorers: { jev_helpfulness: helpfulness },
  thresholds: { scorers: { jev_helpfulness: { min: 0.5 } } },
});

const report = await runEval(spec);
console.log(toMarkdown(report));

const ranked = [...report.cases]
  .sort(
    (a, b) =>
      (b.scorers["jev_helpfulness"]?.score ?? -1) - (a.scorers["jev_helpfulness"]?.score ?? -1),
  )
  .map((c) => `${c.id}=${(c.scorers["jev_helpfulness"]?.score ?? -1).toFixed(2)}`);
const truthOrder = [...CASES].sort((a, b) => a.rank - b.rank).map((c) => c.id);
console.log("\nrank by Jev score:", ranked.join(" > "));
console.log("truth rank order:", truthOrder.join(" > "));
console.log(
  ranked.map((r) => r.split("=")[0]).join(",") === truthOrder.join(",")
    ? "rank order MATCHES ground truth"
    : "rank order DIFFERS from ground truth",
);
