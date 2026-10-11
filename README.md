# @corbits/evals

Evals for agents and workflows in one call: run each case, check it,
print a summary, fail when it gets worse.

## Install

```sh
bun add @corbits/evals
```

Bun only (>=1.2.0).

## Example

```ts
import { evaluate, mentions, under } from "@corbits/evals";

const report = await evaluate("refund-agent", {
  run: refundAgent, // an @intx/agent Agent, workflow(), or (input) => output
  cases: [{ name: "duplicate charge", input: "I was charged twice" }],
  checks: {
    refunds: mentions(["refund"]),
    readyToSend: "Is this reply ready to send to the customer?",
    fast: under({ ms: 5_000 }),
  },
  baseline: "evals/refund.baseline.json",
  about: { model: "qwen2.5:7b" },
});
console.log(report.markdown());
```

## Checks

`checks` maps a name to a check. Without `checks`, one `matches` check
compares output with `expect`. Every check gets the run
`r = { input, output, expect, steps, ms }`; `output` is whatever the run
returned.

- **Code**: `(r) => boolean | number`, sync or async. A number is 0..1
  and passes only at 1; return a boolean to pick your own threshold, or
  `{ pass, value, explanation }` for detail.
- **Sentence**: a yes/no question for Jev about the run. Passes at
  p(yes) >= 0.7, fails at <= 0.3, fails as `unsure (p=…)` in between.
- **Helpers**:

| helper                      | passes when                                                               |
| --------------------------- | ------------------------------------------------------------------------- |
| `matches(field?)`           | output deep-equals expect, or the same field (key or accessor) of each    |
| `fitsSchema(schema)`        | output satisfies a Standard Schema (arktype, zod, valibot)                |
| `mentions(words)`           | output contains every word, case-insensitive; value is the fraction found |
| `avoids(words)`             | output contains none of the words                                         |
| `ranSteps(names)`           | `tool` and `step` names match `names`, order ignored; value is their F1   |
| `stepsAtMost(n)`            | the run took at most `n` steps                                            |
| `under({ ms })`             | the run finished within `ms`                                              |
| `ask(q, { options, pass })` | Jev picks an option named in `pass`                                       |
| `ask(q, { levels, pass })`  | Jev grades at level `pass` or above (levels lowest first)                 |

`mentions` and `avoids` also take `(r) => words` for per-case words.
`mentions` and `ranSteps` take `{ atLeast }` to pass on partial credit.
`ask` fails as unsure when Jev's top probability is below 0.6.

A check that throws, hangs past `timeout`, or returns anything else fails
itself closed; its siblings still run. Jev transport failures fail closed.

Jev sees `{ input, output, expect, steps }`. Configure it with
`judge: jev({ endpoint, model, apiKey, timeout })`; `endpoint` is
`"official"` (default), `"gateway"` or a URL. Without an `apiKey` the
key comes from the environment as `@corbits/system-one` reads it.

## Runs

- **Function**: `(input, signal) => output`. `signal` aborts on `timeout`.
- **Agent**: an `@intx/agent` Agent, detected by `send`. Input is sent
  as a message; output is the reply.
- **Workflow**: `workflow(definition, { invokeStep })` from
  `@corbits/evals/workflow`. A definition cannot run locally without a
  step invoker, and the root never loads `@intx/workflow`, so a bare
  definition is refused. Each step lands in `r.steps`. `output` picks the
  result from the finished run (default: the last listed step's output),
  `trigger` maps the input to the trigger payload. Without them, type the
  run as `workflow<I, O>(...)`.

`repeats` runs each case several times; a check passes only if every
attempt passes. `concurrency` (default 4) bounds cases in flight;
`timeout` (`"60s"` or ms) bounds each run and each check.

## Cases

An array of `{ name?, input, expect? }`, or the path of a JSONL file of
the same objects. `name` keys the case in reports and baselines and
defaults to the input.

## Gate and baseline

`evaluate` prints per check passed/total and rejects with `EvalFailure`
when the eval fails, so a script exits non-zero in CI. Its message lists
the failed case × checks; `.report` holds every result. Without a
baseline, every case must pass unless `passRate` says otherwise.

With `baseline`, the stored run is compared case × check: anything that
passed before and fails now, or a pass rate below `passRate` (default:
the stored rate), fails the eval; flips are printed as `fixed` / `broke`.
Added or removed cases count toward the rate only, so update the baseline
after changing cases. A missing baseline fails.
`CORBITS_EVALS_UPDATE=1` (or `update: true`) writes it instead of
comparing, failing only on an explicit `passRate`. Baselines store each
case × check pass and value plus `about`, with no times, so they diff
cleanly in git. `report.save(path)` writes the same form. `quiet: true`
skips the summary.

## Peers

- `@corbits/evals`: `@intx/inference` and `@intx/types`, peers of
  `@corbits/system-one`.
- `@corbits/evals/workflow`: `@intx/workflow` (optional).

## Examples

`examples/` runs against local Ollama (`bun examples/<name>.ts`).
`examples/ports/` reimplements common eval patterns and prints agreement
with ground truth against a naive baseline: ABCDE factuality, keyword
overlap, faithfulness, pairwise battle, 1-10 helpfulness.

## Gates

`bun run check` = typecheck + lint + format:check + unit + e2e.
Behavior lives in `e2e/`; `src` unit tests stay thin.
