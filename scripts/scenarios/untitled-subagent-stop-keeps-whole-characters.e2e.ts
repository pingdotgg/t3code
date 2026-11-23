// @effect-diagnostics nodeBuiltinImport:off -- The scenario stages a local ACP executable.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { MOBILE, MOBILE_T3_HOME } from "../e2e.config.ts";
import { environmentId, makeState, runPromise } from "./t3.ts";
import { IOS, test } from "./t3-mobile.ts";

const AGENT = "untitled-delegate-agent";
// The emoji's two UTF-16 units straddle unit 77, where a prompt-derived title is cut.
const TASK = `${"x".repeat(76)}😀 then report back`;
// The parent delegates through T3's real delegate_task tool, with no title. Neither turn ends,
// so the subagent stays running and offers its Stop button.
const ACP = `
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let sessions = 0;
let bridge;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentInfo: { name: "${AGENT}", version: "1.0.0" }, agentCapabilities: {}, authMethods: [] } });
  } else if (method === "session/new") {
    bridge = params.mcpServers.find((server) => server.name === "t3-code");
    send({ id, result: { sessionId: "session-" + ++sessions } });
  } else if (method === "session/prompt") {
    const text = params.prompt.map((part) => part.text ?? "").join("");
    // T3 puts its runtime notes ahead of the first message; the child's prompt never matches.
    if (!text.includes("Delegate the task.")) continue;
    const input = { task: ${JSON.stringify(TASK)}, target: { providerInstanceId: "${AGENT}", model: "default" } };
    const args = bridge.args.map((arg) => (arg === "acp-mcp-bridge" ? "acp-mcp-call" : arg));
    const env = { ...process.env, ...Object.fromEntries(bridge.env.map((entry) => [entry.name, entry.value])) };
    spawn(bridge.command, [...args, "delegate_task", JSON.stringify(input)], { env, stdio: ["ignore", "ignore", "inherit"] });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "An untitled subagent's Stop button names it without a broken character",
  IOS,
  async ({ t3, app, screen, device }) => {
    const project = await t3.project("demo");
    const script = NodePath.join(project, "untitled-delegate-acp.mjs");
    await NodeFSP.writeFile(script, ACP);
    const settingsPath = NodePath.join(MOBILE_T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(originalSettings);
    settings.providerInstances[AGENT] = {
      driver: "acpRegistry",
      displayName: "Untitled Delegate Agent",
      enabled: true,
      config: { source: "local", commandPath: process.execPath, commandArgs: [script] },
    };
    try {
      await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));
      const { cli } = makeState(MOBILE_T3_HOME, { T3CODE_PORT: String(MOBILE.serverPort) });
      // The watcher reloads settings asynchronously. Retry only before a thread was created.
      let threadId: string | undefined;
      for (let attempt = 0; attempt < 8 && threadId === undefined; attempt++) {
        const started = await runPromise(
          cli(
            [
              "thread",
              "start",
              project,
              "Delegate the task.",
              "--title",
              "Untitled subagent",
              "--provider",
              AGENT,
              "--model",
              "default",
              "--json",
            ],
            [0, 1],
          ),
        );
        if (!started.stdout.includes("threadId")) continue;
        threadId = (JSON.parse(started.stdout) as { threadId: string }).threadId;
      }
      if (threadId === undefined) throw new Error("Could not start the delegating turn.");

      await t3.open();
      // A working thread is listed behind this button, not as a row.
      await screen.getByRole("button", "1 working thread").waitFor({ timeout: 120_000 });
      const environment = await runPromise(
        environmentId(`http://${MOBILE.host}:${MOBILE.serverPort}`),
      );
      await device.openLink(`t3code-dev://threads/${environment}/${threadId}`, {
        app: "com.t3tools.t3code.dev",
      });
      await device.alert("accept").catch(() => {});

      await screen.getByRole("button", /^Open agents/).tap({ timeout: 60_000 });
      const stop = screen.getByRole("button", /^Stop agent x{76}/);
      await stop.waitFor({ timeout: 30_000 });
      try {
        await expect(stop).toHaveAccessibleName(`Stop agent ${"x".repeat(76)}...`);
      } finally {
        await stop.tap();
        await app.screenshot("stop-dialog");
        await device.alert("dismiss").catch(() => {});
      }
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
    }
  },
);
