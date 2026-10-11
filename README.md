# @corbits/evals

Evals for agents and workflows. Define a dataset, a task, and scorers —
run locally, get a report.

```ts
import {
  defineEval,
  runEval,
  jevJudge,
  exactMatch,
  fromIntxAgent,
  toMarkdown,
} from "@corbits/evals";

const spec = defineEval({
  name: "refund-agent",
  dataset: [{ id: "dup-charge", input: "I was charged twice", expected: "refund" }],
  task: fromIntxAgent(agent),
  scorers: {
    exact: exactMatch(),
    ready: jevJudge({
      questions: [
        {
          id: "ready",
          type: "choice",
          instructions: "Ready to send?",
          criteria: { ready: "send", revise: "rework" },
        },
      ],
    }),
  },
  // Scorers measure; the eval author decides what passes.
  thresholds: { scorers: { ready: { allow: ["ready"] } }, passRate: 0.8 },
});
console.log(toMarkdown(await runEval(spec)));
```

## Install

```sh
bun add @corbits/evals
```

Bun only (>=1.2.0): the dataset loaders use `Bun.file`.

## Results and thresholds

A scorer returns a `Result`, never pass/fail:

```ts
type Result =
  | { kind: "score"; value: number } // 0..1
  | { kind: "boolean"; value: boolean } // success(true)
  | { kind: "category"; value: string; scale?: string[] }; // category("Med", ["Low","Med","High"])
```

Pass rules live in `thresholds.scorers`, keyed by scorer name: `{ min }`
for scores, `{ expect }` for booleans, `{ allow }` or `{ atLeast }` for
categories. Without one, a score must be 1, a boolean true, a category the
top of its scale. A threshold of the wrong kind fails closed with a reason.
The runner normalizes every result to 0..1 for `avgScore` and diffs.

## What it does

- **Runner** — `defineEval` / `runEval`: dataset → task per case
  (concurrency, repeats, timeout) → score → compile. Reports via
  `toMarkdown` / `toJUnit`. `timeoutMs` aborts the task via its signal;
  `scorerTimeoutMs` (default: `timeoutMs`) bounds each scorer. A
  scorer that throws, hangs, or returns a malformed result fails
  itself closed without touching its siblings. Options are validated
  up front (empty dataset, duplicate ids, unknown threshold names,
  non-finite numbers throw).
- **Tasks** — `fromFunction` for anything callable, `fromIntxAgent`
  for a real `@intx/agent`, and `fromIntxWorkflow` (from
  `@corbits/evals/workflow`) to run a whole workflow per case with every
  step recorded in the trajectory. All stamp `latencyMs` and honor the
  abort signal.
- **Scorers** — deterministic (`exactMatch`, `keywordCoverage`,
  `toolCallF1`, `latencyBudget`, `combineAll`) and judges. `toolCallF1`
  matches `tool` and `step` names, so it scores workflows too. Every
  scorer returns its lowest result when it has nothing to compare against.
- **Jev judge** — `jevJudge` via `@corbits/system-one`. All questions
  go in one POST. A choice question yields a category over its criteria
  (or a score when `scores` grades the options), a score question a
  score, a boolean/noul question a boolean with P(true) in metadata.
  Transport, key and thrown failures return score 0.
- **Agent judge** — `agentJudge` for open-ended rubrics, backed by any
  sender (`senderFromIntxAgent`). Pass `timeoutMs`; keep `parse` strict.
- **Datasets** — `fromJsonl` / `fromCsv` load `EvalCase[]` from disk,
  validating shape and rejecting duplicate ids with line numbers.
- **Diffing** — every report carries `startedAt` and the spec's
  `metadata` (e.g. `{ model }`). `toJson` emits it stamped with
  `REPORT_FORMAT_VERSION`; `parseReport` / `fromJsonReport` load it back,
  refusing a missing or unknown version and malformed shapes.
  `diffReports` lists pass flips, score deltas, and added/removed cases
  by id between two runs of the same eval, and throws across evals.
  Store the JSON wherever you like (CI artifact, committed baseline).

## Peers

- `@corbits/evals`: `@intx/inference` and `@intx/types`, peers of
  `@corbits/system-one`.
- `fromIntxAgent`, `senderFromIntxAgent`, `agentJudge`: `@intx/agent`
  (optional).
- `@corbits/evals/workflow`: `@intx/workflow` (optional).

## Examples

`examples/` runs against local Ollama (`bun examples/<name>.ts`).
`examples/ports/` reimplements common eval patterns with ground-truth
agreement vs a naive baseline: ABCDE factuality (7/8 vs 3/8), keyword
overlap (5/5 vs 2/5) and faithfulness (6/6 vs 1/6), pairwise battle
(3/4), 1-10 helpfulness scoring.

## Gates

`bun run check` = typecheck + lint + format:check + unit + e2e.
Behavior lives in `e2e/`; `src` unit tests stay thin.
