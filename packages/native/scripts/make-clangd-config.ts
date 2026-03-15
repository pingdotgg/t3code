import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// This is probably over-engineered, but at least it's clear.

const scriptPath = fileURLToPath(import.meta.url);
console.log("Script path:", scriptPath);
const packageRoot = join(dirname(scriptPath), "..");
console.log("Project root:", packageRoot);

// Technical note: N-API is now called Node-API.
// See: https://nodejs.medium.com/renaming-n-api-to-node-api-27aa8ca30ed8

function resolveNodeHeadersDir(): string {
  const nodeExecPath = execFileSync("node", ["-p", "process.execPath"], {
    encoding: "utf8",
  }).trim();
  const headersDir = join(dirname(nodeExecPath), "..", "include", "node");
  if (!existsSync(headersDir)) {
    throw new Error(`Could not find Node headers at ${headersDir}`);
  }
  return headersDir;
}

function resolvePackageDir(packageName: string): string {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  return dirname(realpathSync(packageJsonPath));
}

const includePaths = [
  // We need the Node.js headers for Node-API.
  resolveNodeHeadersDir(),
  // We need the node-addon-api headers for the C++ bindings that wrap Node-API.
  resolvePackageDir("node-addon-api"),
];
for (const path of includePaths) {
  console.log("Adding include path:", path);
}

let flags = ["-std=c++20", "-xobjective-c++", ...includePaths.map((path) => `-I${path}`)];

const clangdConfig = `
CompileFlags:
\tCompiler: /usr/bin/clang++
\tAdd:
${flags.map((flag) => `\t\t- ${flag}`).join("\n")}
`
  // We use `\t` above for clarity, but clangd needs spaces.
  .replace(/\t/g, "  ")
  // We remove the leading newline for cleanliness.
  .trimStart();

import { writeFileSync } from "node:fs";
writeFileSync(join(packageRoot, ".clangd"), clangdConfig);
console.log("Wrote .clangd config file.");
