# AGENTS.md

## Purpose

`@corbits/evals` package.

Public call: `runEvaluation({ name, data, task, scorers })`. There is no
`defineEval`, no `evaluate(name, options)`, and no `runEval`. Ground truth
is `expectedOutput`. JSONL keys `expect` and `expected` throw.

The judge model is `judgeModel()` from `@corbits/evals/workflow`: one step,
inference source pinned on the agent. Thresholds are `systemOne`. `jev` is
an alias of `systemOne`, not an endpoint. Do not document `jev({ endpoint })`.

Saved experiments are format 2 (`{ format: 2, name, cases }`). Format 1 is
rejected. `ranSteps([])` fails when `steps` is empty; an observed model-only
run still passes. CLI is `corbits-eval run <file>` and exits 0, 1, or 2.

`includes` and the four prebuilt workflow scorers
(`faithfulness`, `answerRelevancy`, `correctness`, `trajectoryAccuracy`) exist.
Do not document toxicity, bias, or pii.

## Conventions

- Read `README.md` before changing public behavior.
- Keep changes focused; update docs and tests alongside code changes.
- Run `bun run check` before declaring work complete.
