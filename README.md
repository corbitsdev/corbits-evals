# @corbits/evals

Evals for agents and workflows in one call: run each case, check it,
print a summary, fail when a check misses or drops more than allowed.

## Install

```sh
bun add @corbits/evals
```

Bun only (>=1.2.0).

## Example

```ts
import { mentions, runEvaluation, under } from "@corbits/evals";

const report = await runEvaluation({
  name: "refund-agent",
  task: refundAgent, // an @intx/agent Agent, workflow(), or (input) => output
  data: [{ name: "duplicate charge", input: "I was charged twice" }],
  scorers: {
    refunds: mentions(["refund"]),
    readyToSend: "Is this reply ready to send to the customer?",
    fast: under({ ms: 5_000 }),
  },
  allow: { readyToSend: 1 },
  compare: "evals/refund.last.json",
  about: { model: "qwen2.5:7b" },
});
console.log(report.markdown());
```

## Checks

`checks` maps a name to a check. Without `checks`, one `matches` check
compares output with `expectedOutput`. Every check gets the run
`r = { input, output, expectedOutput, steps, ms }`; `output` is whatever the run
returned.

- **Code**: `(r) => boolean | number`, sync or async. A number is 0..1
  and passes only at 1; return a boolean to pick your own threshold, or
  `{ pass, value, explanation }` for detail.
- **Sentence**: a yes/no question for Jev about the run. Passes at
  p(yes) >= `yes`, fails at <= `no` (0.7 / 0.3 by default), fails as
  `unsure (p=…)` in between. `{ question, yes, no }` sets its own bars.
- **Helpers**:

| helper                        | passes when                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `matches(field?)`             | output deep-equals expectedOutput, or the same field (key or accessor) of each |
| `fitsSchema(schema)`          | output satisfies a Standard Schema (arktype, zod, valibot)                     |
| `mentions(words)`             | output contains every word, case-insensitive; value is the fraction found      |
| `avoids(words)`               | output contains none of the words                                              |
| `ranSteps(names)`             | `tool` and `step` names match `names`, order ignored; value is their F1        |
| `stepsAtMost(n)`              | the run took at most `n` steps                                                 |
| `under({ ms })`               | the run finished within `ms`                                                   |
| `ask(q, { options, pass })`   | Jev picks an option named in `pass`                                            |
| `ask(q, { options, passAt })` | Jev picks an option; its credit (0..1) is the value and passes at `passAt`     |
| `ask(q, { levels, pass })`    | Jev grades at level `pass` or above (levels lowest first)                      |

`mentions` and `avoids` also take `(r) => words` for per-case words.
`mentions` and `ranSteps` take `{ atLeast }` to pass on partial credit.
`ask` fails as unsure when Jev's top probability is below `sure`
(0.6 by default; a check's own `sure` wins).

A check that throws, hangs past `timeout`, or returns anything else fails
itself closed; its siblings still run. Jev transport failures fail closed.

Jev sees `{ input, output, expectedOutput, steps }`, and a case's string and
`ask` checks answer in one call. Configure it with
`judge: jev({ endpoint, model, apiKey, timeout })`; `endpoint` is
`"official"` (default), `"gateway"` or a URL. Without an `apiKey` the
key comes from the environment as `@corbits/system-one` reads it.

Thresholds: a yes/no check passes at p(yes) >= `yes` and fails at
p(yes) <= `no` (0.7 / 0.3); `ask` fails as unsure when its top
probability is under `sure` (0.6). Retune them per judge with
`jev({ thresholds: { yes, no, sure } })` or per check as above.
Thresholds are tuned to a judge version, so pin `model` — e.g.
`jev({ model: "jev-1.13.0" })` — when they must stay stable.

Escalation: `sure` doubles as the escalation gate. Give the judge an
agent — `jev({ escalate: agent })`, anything with
`send(prompt)` returning `{ type: "reply", reply }` or
`{ type: "suspended" }`, e.g. an `@intx/agent` agent from a `@corbits/*`
adapter — and every unsure decision is re-asked with the exact answer
space. The reply goes through the same pass rules minus the confidence
gate, so a primary unsure can still fail after escalation. A thrown,
suspended, or off-answer-space reply fails the case closed. Validate the
escalated model per workload too: Jev's unsure says nothing about the
fallback's accuracy, and reasoning models may answer in prose the answer
space cannot absorb — those fail closed by design.

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

An array of `{ name?, input, expectedOutput?, must?, skip? }`, or the path of a
JSONL file of the same objects. `name` keys the case in reports and
compared runs and defaults to the input.

## Passing

```ts
await runEvaluation({
  name: "judge",
  task: run,
  data, // a case can say { must: ["tests"], skip: ["docs"] }
  scorers,
  compare: "evals/judge.last.json", // read: measure drops against it
  save: "evals/judge.last.json", // write: store this experiment, pass or fail
  allow: {
    tests: { miss: 1, drop: 0 },
    docs: { miss: 5, drop: 2 },
    focused: 3, // { miss: 3 }
  },
});
```

Per check, `allow` sets (default 0):

- **miss**: cases that may fail.
- **drop**: cases that passed in the `compare` run and may fail now. A
  fixed case does not offset a broken one.

A case's `must` checks must pass whatever `allow` says; its `skip` checks
are not run or counted.

`runEvaluation` prints each scorer's passes, misses and drops, and rejects with
`EvalFailure` naming the limit each failing scorer broke and its failed
cases; `.report` holds every result.

An experiment is each case × scorer pass and value — plus a Jev scorer's
probability distribution and confidence — and `about`, no times.
`compare` only reads; a missing file skips drops. `save` only writes, on
every run. One path for both compares with the last experiment, then replaces
it. `compare` also takes an experiment from an earlier `runEvaluation` of the same
evaluation, with no file: `runEvaluation({ ...spec, compare: before.experiment })`.
Flips print as `fixed` / `broke`, new and gone cases as `added` /
`removed`. `quiet: true` skips the summary.

## Calibrating

Thresholds are per-workload starting points, not constants. `calibrate`
runs a labeled sample through Jev once and prints, per check, how many
verdicts agree, land unsure, or confidently disagree at each threshold:

```ts
const table = await calibrate("refund-agent", {
  run: refundAgent,
  cases: labeledCases, // { input, expectedOutput?, labels: { readyToSend: true } }
  checks: { readyToSend: "Is this reply ready to send to the customer?" },
  judge,
});
console.log(table.markdown());
```

Yes/no checks sweep `yes` with `no` mirrored; `ask` sweeps `sure`. Paste
the recommended override into the check or judge. Zero confident
disagreements is the goal; if none exists, the fewest wins.

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
