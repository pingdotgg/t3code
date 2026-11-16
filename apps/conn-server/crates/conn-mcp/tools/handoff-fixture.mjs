// Model-free calling-thread credentials from the existing Claude CLI stand-in and fake provider.
import * as fs from "node:fs";
import * as path from "node:path";

export function claudeStub(root) {
  const dir = path.join(root, "cli");
  fs.mkdirSync(path.join(dir, "records"), { recursive: true });
  const stub = path.join(dir, "stub-claude");
  fs.copyFileSync(new URL("../../conn-provider-claude/tools/conformance/stub-claude", import.meta.url), stub);
  fs.chmodSync(stub, 0o755);
  const binary = path.join(dir, "claude");
  fs.writeFileSync(binary, [
    "#!/bin/sh",
    'case "$1" in --version) echo "2.1.322 (Claude Code)"; exit 0;; esac',
    'if [ "$1" = "auth" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\'; exit 0; fi',
    `exec '${process.execPath.replaceAll("'", "'\\''")}' '${stub.replaceAll("'", "'\\''")}' "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  return { binary, records: path.join(dir, "records") };
}

// File events signal provider startup; no sleeps or repeated status requests.
function untilFile(directory, read) {
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(directory, check);
    const timer = setTimeout(() => { watcher.close(); reject(new Error("No fixture MCP credential in 90 s")); }, 90_000);
    function check() {
      let value;
      try { value = read(); } catch { return; }
      if (value === undefined) return;
      clearTimeout(timer);
      watcher.close();
      resolve(value);
    }
    check();
  });
}

export function tsCredential(directory) {
  return untilFile(directory, () => {
    for (const name of fs.readdirSync(directory).filter((n) => n.endsWith(".json")).reverse()) {
      const record = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      const at = record.argv?.indexOf("--mcp-config");
      const config = at === undefined || at === -1 ? undefined : JSON.parse(record.argv[at + 1]);
      const message = record.stdin?.map((line) => typeof line === "string" ? JSON.parse(line) : line)
        .find((message) => message.request?.subtype === "mcp_set_servers");
      const server = config?.mcpServers?.["t3-code"] ?? message?.request.servers?.["t3-code"];
      if (server?.headers?.Authorization) return server;
    }
  });
}

export function rustCredential(file) {
  return untilFile(path.dirname(file), () => {
    if (!fs.existsSync(file)) return;
    return JSON.parse(fs.readFileSync(file, "utf8")).servers?.[0];
  });
}

export function fileText(file) {
  return untilFile(path.dirname(file), () => fs.existsSync(file) ? fs.readFileSync(file,"utf8") : undefined);
}
