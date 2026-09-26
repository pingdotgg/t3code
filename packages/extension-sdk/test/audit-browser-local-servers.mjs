import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

// Gate 4 covers both authored sources and the exact installed server bundle.
const root = new URL("../examples/browser-local-servers/", import.meta.url);
const files = [
  "extension.ts",
  "server.ts",
  ".t3-extension/t3-extension.json",
  ".t3-extension/server.mjs",
];
const findings = [];
const hashes = {};
for (const file of files) {
  const bytes = await NodeFSP.readFile(new URL(file, root));
  const content = bytes.toString("utf8");
  hashes[file] = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (
    /apps\/(web|server|desktop|mobile)\/|~\/|client-runtime|subscribeDiscoveredLocalServers|preview(?:Open|Navigate|ReportStatus|AutomationConnect)|desktopBridge|WebSocket/.test(
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
const report = { package: "example.browser-local-servers", files: hashes, findings };
if (process.argv.includes("--write")) {
  await NodeFSP.writeFile(
    NodeURL.fileURLToPath(
      new URL("fixtures/browser-local-servers-import-audit.json", import.meta.url),
    ),
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(JSON.stringify(report, null, 2));
if (findings.length) process.exitCode = 1;
