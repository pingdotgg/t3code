#!/usr/bin/env node
// Fake Antigravity ACP agent for #29379: initialize and authenticate succeed, session/new never answers.
const fs = require("fs"), path = require("path");
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const mode = fs.readFileSync(path.join(dir, "mode"), "utf8").trim();
const log = (m) => fs.appendFileSync(path.join(dir, "agent.log"), `${new Date().toISOString()} ${m}\n`);
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
log(`start mode=${mode} argv=${JSON.stringify(process.argv.slice(2))}`);
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    log(`recv ${msg.method ?? "response"} id=${msg.id}`);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, auth: { logout: {} } },
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }, { id: "oauth-business", name: "Gemini Enterprise" }],
        agentInfo: { name: "antigravity-acp", title: "Fake Antigravity", version: "1.4.5" },
      }});
    } else if (msg.method === "authenticate") {
      const reply = () => { log("answer authenticate"); send({ jsonrpc: "2.0", id: msg.id, result: { _meta: { antigravity: { tier: { name: "Gemini Enterprise Plus", id: "gcp-ge-plus-tier", upgradeUri: "" } } } } }); };
      if (mode === "browser") {
        process.stderr.write('__T3_ANTIGRAVITY_AUTH_URL__"https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=fake-state"\n');
        setTimeout(reply, 20000);
      } else reply();
    } else if (msg.method === "session/new") {
      process.stderr.write("mcp_servers.py:230] Attempting to load global MCP configs from <GEMINI_HOME>/config/mcp_config.json\n");
      log("session/new: never answering");
    } else if (msg.id !== undefined && msg.method) {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});
process.stdin.on("end", () => { log("stdin end"); process.exit(0); });
