import * as NodeModule from "node:module";

// The gt CLI picks its commands from package.json, and gt-i18n alone gets no `generate`.
const { Command } = NodeModule.createRequire(import.meta.resolve("gt"))("commander");
const { NodeCLI } = await import("gt/cli/node");

const program = new Command("gt");
new NodeCLI(program, "gt-node", []).init();
await program.parseAsync([
  "node",
  "gt",
  "generate",
  "--skip-version-check",
  ...process.argv.slice(2),
]);
