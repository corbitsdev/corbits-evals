# AGENTS.md

## Purpose

`@corbits/evals` runs eval cases against agents, workflows, or plain functions,
applies code and sentence checks, and prints a Markdown report. It does not own
agent runtime or model inference beyond the optional Jev sentence checks.

## Layout

- `src/evaluate.ts`: public `evaluate` entry point and result aggregation.
- `src/runner.ts`: per-case execution, timeouts, and step capture.
- `src/checks.ts`: code, sentence, and helper checks.
- `src/reports.ts`: Markdown and JSON reporting.
- `src/datasets.ts`: dataset helpers.
- `src/index.ts`: the only module consumers import from.

## Rules

- Public API changes need matching docs and tests.
- Sentence checks route through the configured Jev endpoint; keep that path
  optional so code-only evals run offline.
- Do not add agent-runtime logic here; delegate to `@intx/agent`.

## Local development

```sh
bun install
bun run check
```
