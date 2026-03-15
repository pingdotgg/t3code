import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const tscPath = require.resolve("typescript/bin/tsc");
const cwd = path.resolve(import.meta.dirname, "..");

const child = spawn(process.execPath, [tscPath, "--noEmit"], {
  cwd,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
});

child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stderr.write(text);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  if (code === 0) {
    process.exit(0);
    return;
  }

  const hasTypeScriptErrors = /error TS\d+:/.test(output);
  process.exit(hasTypeScriptErrors ? (code ?? 1) : 0);
});
