import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Keep destructive evidence resets inside a dedicated tree, away from projects.
const root = "/tmp/t3-11476-capture-fixture";
const children = [
  "existing/nested",
  "a-long-folder-name-for-narrow-viewport-truncation",
  ".hidden",
];
const phase = process.argv[2];
if (!["reset", "mkdir", "remove", "empty", "restore"].includes(phase ?? "")) {
  throw new Error("Expected reset, mkdir, remove, empty, or restore");
}
if (phase === "reset" || phase === "empty") {
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.mkdirSync(root, { recursive: true });
}
if (phase === "reset" || phase === "restore") {
  for (const child of children) NodeFS.mkdirSync(NodePath.join(root, child), { recursive: true });
}
if (phase === "mkdir")
  NodeFS.mkdirSync(NodePath.join(root, "created-externally"), { recursive: true });
if (phase === "remove") NodeFS.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ root, phase, children, timestamp: new Date().toISOString() }));
