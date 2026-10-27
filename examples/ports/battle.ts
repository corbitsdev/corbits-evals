// Pairwise beats absolute 1-10 for small judges.
// Run: bun examples/ports/battle.ts
import { ask, runEvaluation } from "../../src/index.js";
import { localJev } from "../ollama.js";

const QUESTION = "What is the capital of France?";

const ANSWERS: Record<string, string> = {
  best: "Paris is the capital of France, confirmed by every atlas.",
  good: "The capital of France is Paris.",
  thin: "Paris.",
  wrong: "The capital of France is Lyon, a lovely city.",
};

// Ground truth: A wins every pair.
const PAIRS: [string, string][] = [
  ["best", "good"],
  ["good", "thin"],
  ["thin", "wrong"],
  ["best", "wrong"],
];

// Jev sees the case input, so each pair goes in as { question, A, B }.
const report = await runEvaluation({
  name: "port-battle",
  task: (pair: { question: string; A: string; B: string }) => pair,
  data: PAIRS.map(([a, b]) => ({
    name: `${a}-vs-${b}`,
    input: { question: QUESTION, A: ANSWERS[a] ?? "", B: ANSWERS[b] ?? "" },
  })),
  scorers: {
    battle: ask("Which answer better serves the question? Correctness first, then completeness.", {
      options: {
        A: "answer A is better",
        B: "answer B is better",
        tie: "they are equally good",
      },
      pass: "A",
    }),
  },
  allow: { battle: PAIRS.length },
  judge: localJev,
});
console.log(report.markdown());
console.log(`\npairwise agreement with ground truth: ${report.passed}/${PAIRS.length}`);
