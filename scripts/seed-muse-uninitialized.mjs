import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/seed-muse-uninitialized.mjs <new-fixture-directory>");
}

// This synthetic launcher reproduces only the version-probe failure, not Muse setup or a turn.
const fixture = JSON.parse(
  await NodeFSP.readFile(new URL("./fixtures/muse-uninitialized.json", import.meta.url), "utf8"),
);
const binaryPath = NodePath.join(NodePath.resolve(directory), "muse");
await NodeFSP.mkdir(NodePath.resolve(directory), { recursive: true });
await NodeFSP.writeFile(
  binaryPath,
  `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== "--version") {
  process.stderr.write("Synthetic status fixture supports --version only.\\n");
  process.exit(2);
}
process.stderr.write(${JSON.stringify(fixture.stderr)});
process.exit(${JSON.stringify(fixture.exitCode)});
`,
  { flag: "wx", mode: 0o755 },
);
console.log(`Synthetic fixture: ${binaryPath}`);
console.log("Select this binary only in an isolated environment's Muse settings, then refresh.");
console.log(
  "Enable Muse and clear custom models. This is not a real Muse launcher or recovery proof.",
);
