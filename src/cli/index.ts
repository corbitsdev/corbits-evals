#!/usr/bin/env bun
import { Cli } from "incur";

const cli = Cli.create("corbits-eval", {
  description: "Run a corbits evaluation file",
}).fs(new URL("./", import.meta.url));

if (import.meta.main) {
  await cli.serve();
}

export { cli };
