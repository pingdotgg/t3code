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
      const server = config?.mcpServers?.["conn"] ?? message?.request.servers?.["conn"];
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

export function projectProviderPolicy(server, projectId, enabled, scripts) {
  return updateSettings(server,{projectSettingsOverrides:{[projectId]:{providerInstances:{claudeAgent:{enabled}},defaultProjectScripts:scripts}}});
}

export async function updateSettings(server, patch) {
  const response = await fetch(`${server.origin}/api/auth/websocket-ticket`, {
    method: "POST", headers: {authorization:`Bearer ${server.bearer}`},
  });
  if (!response.ok) throw new Error(`policy ticket: ${response.status}`);
  const {ticket} = await response.json();
  const url = new URL(server.origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.search = new URLSearchParams({orchestrationProtocol:"2",wsTicket:ticket}).toString();
  const socket = new WebSocket(url);
  try {
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error("No policy RPC response in 30 s")),30_000);
      const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      socket.onerror = () => finish(new Error("Policy RPC socket failed"));
      socket.onopen = () => socket.send(JSON.stringify({_tag:"Request",id:"1",tag:"server.updateSettings",headers:[],payload:{patch}}));
      socket.onmessage = ({data}) => {
        for (const line of String(data).split("\n").filter(Boolean)) {
          const parsed = JSON.parse(line);
          for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
            if (message._tag === "Ping") socket.send(JSON.stringify({_tag:"Pong"}));
            if (message._tag === "Exit" && message.requestId === "1") finish(message.exit?._tag === "Success" ? undefined : new Error(`Policy RPC: ${JSON.stringify(message.exit)}`));
          }
        }
      };
    });
  } finally { socket.close(); }
}
