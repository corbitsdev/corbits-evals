// 1-10 helpfulness as Jev levels. Rank order of four answers is the
// ground truth. Run: bun examples/ports/mtbench-score.ts
import { ask, runEvaluation } from "../../src/index.js";
import { localJev } from "../ollama.js";

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

const report = await runEvaluation({
  name: "port-mtbench-score",
  task: (input: { question: string; id: string }) =>
    CASES.find((c) => c.id === input.id)?.answer ?? "",
  data: CASES.map((c) => ({ name: c.id, input: { question: QUESTION, id: c.id } })),
  scorers: {
    jev_helpfulness: ask(
      "Rate the output's helpfulness and correctness for the question. A bare fragment with no explanation caps at 5. A complete correct answer with supporting detail scores 8+. A wrong answer scores 1-2.",
      { levels: LEVELS, pass: "6: good" },
    ),
  },
  allow: { jev_helpfulness: CASES.length },
  judge: localJev,
});
console.log(report.markdown());

const score = (name: string) =>
  report.cases.find((c) => c.name === name)?.checks["jev_helpfulness"]?.value ?? -1;
const ranked = CASES.map((c) => c.id).sort((a, b) => score(b) - score(a));
const truthOrder = [...CASES].sort((a, b) => a.rank - b.rank).map((c) => c.id);
console.log(
  "\nrank by Jev score:",
  ranked.map((id) => `${id}=${score(id).toFixed(2)}`).join(" > "),
);
console.log("truth rank order:", truthOrder.join(" > "));
console.log(
  ranked.join(",") === truthOrder.join(",")
    ? "rank order MATCHES ground truth"
    : "rank order DIFFERS from ground truth",
);
