// Pairwise beats absolute 1-10 for small judges.
// Run: bun examples/ports/battle.ts
import { defineEval, jevJudge, runEval, success, toMarkdown } from "../../src/index.js";
import type { Scorer } from "../../src/index.js";
import { LOCAL_JEV } from "../ollama.js";

const QUESTION = "What is the capital of France?";

const ANSWERS: Record<string, string> = {
  best: "Paris is the capital of France, confirmed by every atlas.",
  good: "The capital of France is Paris.",
  thin: "Paris.",
  wrong: "The capital of France is Lyon, a lovely city.",
};

const PAIRS: { id: string; a: string; b: string; truth: string }[] = [
  { id: "best-vs-good", a: "best", b: "good", truth: "A" },
  { id: "good-vs-thin", a: "good", b: "thin", truth: "A" },
  { id: "thin-vs-wrong", a: "thin", b: "wrong", truth: "A" },
  { id: "best-vs-wrong", a: "best", b: "wrong", truth: "A" },
];

const pairwise = jevJudge<string, string>({
  questions: [
    {
      id: "battle",
      type: "choice",
      instructions:
        "Which answer better serves the question? Correctness first, then completeness.",
      criteria: {
        A: "answer A is better",
        B: "answer B is better",
        tie: "they are equally good",
      },
    },
  ],
  state: (kase) => {
    const pair = PAIRS.find((p) => p.id === String(kase.input));
    return {
      question: QUESTION,
      A: pair ? (ANSWERS[pair.a] ?? "") : "",
      B: pair ? (ANSWERS[pair.b] ?? "") : "",
    };
  },
  ...LOCAL_JEV,
});

const battleJudge: Scorer<string, string> = async (args) => {
  const verdict = await pairwise(args);
  const truth = PAIRS.find((p) => p.id === args.kase.id)?.truth;
  const agree = verdict.label === truth;
  return {
    ...verdict,
    result: success(agree),
    explanation: `picked ${verdict.label ?? "?"}, truth ${truth ?? "?"}`,
  };
};

const spec = defineEval({
  name: "port-battle",
  dataset: PAIRS.map((p) => ({ id: p.id, input: p.id, expected: p.truth })),
  task: async () => ({ output: "compare A vs B" }),
  scorers: { battle: battleJudge },
});

const report = await runEval(spec);
console.log(toMarkdown(report));
const agree = report.cases.filter((c) => c.pass).length;
console.log(`\npairwise agreement with ground truth: ${agree}/${PAIRS.length}`);
