import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Gate 4 covers both authored sources and the exact installed server bundle.
// Pass a directory to audit a fixture instead of the shipped example.
const rootArg = process.argv.find((arg) => arg.startsWith("--root="));
const root = rootArg
  ? NodePath.resolve(rootArg.slice("--root=".length))
  : NodeURL.fileURLToPath(new URL("../examples/browser-sessions/", import.meta.url));
// The recorded root is repo-relative so a fixture regenerated from any checkout
// is identical; the absolute path is only used to read the files.
const repoRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
const recordedRoot = NodePath.relative(repoRoot, NodePath.resolve(root)) + "/";
const files =
  rootArg !== undefined
    ? process.argv.filter((arg) => !arg.startsWith("--")).slice(2)
    : ["extension.ts", "server.ts", ".t3-extension/t3-extension.json", ".t3-extension/server.mjs"];
const findings = [];
const hashes = {};
for (const file of files) {
  const bytes = await NodeFSP.readFile(NodePath.join(root, file));
  const content = bytes.toString("utf8");
  hashes[file] = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (
    /apps\/(web|server|desktop|mobile)\/|~\/|client-runtime|preview(?:Open|Navigate|ReportStatus|AutomationConnect)|desktopBridge|WebSocket/.test(
      content,
    )
  ) {
    findings.push({ file, reason: "private host binding" });
  }
  for (const match of content.matchAll(/(?:from\s*|import\s*\(|require\s*\()["']([^"']+)["']/g)) {
    if (!match[1].startsWith("@t3tools/extension-sdk/"))
      findings.push({ file, reason: "non-SDK import", specifier: match[1] });
  }
}
const report = { package: "example.browser-sessions", root: recordedRoot, files: hashes, findings };
if (process.argv.includes("--write")) {
  await NodeFSP.writeFile(
    NodeURL.fileURLToPath(new URL("fixtures/browser-sessions-import-audit.json", import.meta.url)),
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(JSON.stringify(report, null, 2));
if (findings.length) process.exitCode = 1;
