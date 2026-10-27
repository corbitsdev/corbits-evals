import { Cli, z } from "incur";

import { loadEvalFile } from "../evalFile.js";
import { EvalFailure, runEvaluation } from "../evaluation.js";

export default Cli.command({
  description: "Run an evaluation module",
  args: z.object({
    file: z.string().describe("Evaluation module path, resolved from the current directory"),
  }),
  async run(c) {
    let spec;
    try {
      spec = await loadEvalFile(c.args.file);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return c.error({ code: "EVAL_FILE", message, exitCode: 2 });
    }

    try {
      const report = await runEvaluation(c.format === "json" ? { ...spec, quiet: true } : spec);
      return { name: report.name, ok: report.ok, passed: report.passed, total: report.total };
    } catch (cause) {
      if (cause instanceof EvalFailure) {
        return c.error({ code: "EVAL_FAILED", message: cause.message, exitCode: 1 });
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      return c.error({ code: "EVAL_CONFIG", message, exitCode: 2 });
    }
  },
});
