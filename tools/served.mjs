// What the Conn Server serves, read from its sources and its binary. Used by
// tools/bump-report.mjs and crates/conn-server/tools/decode-coverage.mjs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { repoRoot } from "./monorepo.mjs";
import { sealedEnv } from "./sealed-env.mjs";

/** Every method of the contract, from the generated `methods.json`: [{ tag, stream }]. */
export function contractMethods() {
  const file = NodePath.join(repoRoot, "crates/conn-contract/methods.json");
  return JSON.parse(NodeFS.readFileSync(file, "utf8")).methods;
}

/**
 * Method tags the method table registers: every contract tag written as a string literal in
 * crates/conn-server/src/methods (tests and `table.get(..)` lookups left out). Registrations
 * put the tag on its own line or pass it through helpers, so this reads literals, not calls.
 * [`binaryCoverage`] cross-checks the count against the running server.
 */
export function registeredTags(tags) {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "tests") walk(path);
      } else if (entry.name.endsWith(".rs") && entry.name !== "tests.rs") {
        const text = NodeFS.readFileSync(path, "utf8")
          .split(/\n#\[cfg\(test\)\]/)[0]
          .replace(/\.get\(\s*"[^"]*"\s*\)/g, "");
        for (const m of text.matchAll(/"([A-Za-z][A-Za-z0-9_.-]*)"/g)) if (tags.has(m[1])) found.add(m[1]);
      }
    }
  };
  walk(NodePath.join(repoRoot, "crates/conn-server/src/methods"));
  return found;
}

/**
 * Starts `binary` once on a temp state folder and returns its `methods:` line
 * (`81 of 235 methods (...)`), or undefined. The process is stopped by PID before this returns.
 */
export async function binaryCoverage(binary) {
  if (!binary || !NodeFS.existsSync(binary)) return undefined;
  const program = NodePath.resolve(binary);
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-served-"));
  const project = NodePath.join(tmp, "project");
  NodeFS.mkdirSync(project);
  const child = NodeChildProcess.spawn(
    program,
    ["--listen", "127.0.0.1:0", "--state-dir", NodePath.join(tmp, "state"), "--project", project],
    { cwd: tmp, stdio: ["ignore", "pipe", "pipe"], env: sealedEnv(tmp) },
  );
  try {
    return await new Promise((ok) => {
      let text = "";
      const timer = setTimeout(() => ok(undefined), 15000);
      child.stdout.on("data", (d) => {
        text += d;
        const m = /^methods: (.+)$/m.exec(text);
        if (m) {
          clearTimeout(timer);
          ok(m[1]);
        }
      });
      child.on("error", () => {
        clearTimeout(timer);
        ok(undefined);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        ok(undefined);
      });
    });
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((r) => (child.exitCode === null ? child.once("exit", r) : r()));
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The served count in a `methods:` line. */
export const servedCount = (line) => Number(/^(\d+) of/.exec(line ?? "")?.[1]);
