// @effect-diagnostics nodeBuiltinImport:off -- The scenario stages a local ACP executable and its wake gate.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const COMPLETION = "The background command printed DONE.";
const ACP = `
import { unwatchFile, watchFile } from "node:fs";
import { createInterface } from "node:readline";

const sessionId = "hermes-scenario";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const respond = (id, result) => send({ id, result });
const chunk = (text) => send({
  method: "session/update",
  params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
});
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: 1,
      agentInfo: { name: "hermes-agent", version: "0.23.1" },
      agentCapabilities: { loadSession: true },
      authMethods: [],
    });
  } else if (method === "session/new") {
    respond(id, { sessionId });
  } else if (method === "session/prompt") {
    chunk("Started it in the background.");
    respond(id, { stopReason: "end_turn" });
    // Hermes sends the follow-up on the root session, without another prompt response.
    const gate = process.argv[2];
    watchFile(gate, { interval: 100 }, (stat) => {
      if (stat.nlink === 0) return;
      unwatchFile(gate);
      chunk(${JSON.stringify(COMPLETION)});
    });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "Hermes sends its background completion reply when launched through a wrapper",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    const script = NodePath.join(project, "hermes-acp.mjs");
    const gate = NodePath.join(project, "process-exited");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(originalSettings);
    await NodeFSP.writeFile(script, ACP);
    settings.providerInstances["hermes-wrapper"] = {
      driver: "acpRegistry",
      displayName: "Hermes Agent",
      enabled: true,
      config: {
        source: "local",
        commandPath: process.execPath,
        commandArgs: [script, gate],
      },
    };
    try {
      await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));
      const { cli } = makeState(T3_HOME);
      // The watcher reloads settings asynchronously. Retry only before a thread was created.
      let threadId: string | undefined;
      for (let attempt = 0; attempt < 8 && threadId === undefined; attempt++) {
        const started = await runPromise(
          cli(
            [
              "thread",
              "start",
              project,
              "Start a background command that reports DONE when it exits.",
              "--title",
              "Hermes background reply",
              "--provider",
              "hermes-wrapper",
              "--model",
              "default",
              "--wait",
              "--json",
            ],
            [0, 1],
          ),
        );
        if (!started.stdout.includes("threadId")) continue;
        const result = JSON.parse(started.stdout) as {
          threadId: string;
          status: string;
          reply: string | null;
        };
        if (
          result.status !== "completed" ||
          !result.reply?.includes("Started it in the background.")
        ) {
          throw new Error(
            `Hermes foreground turn did not complete: ${started.stdout} ${started.stderr}`,
          );
        }
        threadId = result.threadId;
      }
      if (threadId === undefined) throw new Error("Could not start the Hermes foreground turn.");

      await t3.open({ threadId });
      await screen
        .getByText("Started it in the background.", { exact: true })
        .waitFor({ timeout: 60_000 });
      await NodeFSP.writeFile(gate, "");
      try {
        await expect(screen.getByText(COMPLETION, { exact: true })).toBeVisible({
          timeout: 15_000,
        });
      } finally {
        await app.screenshot("hermes-background-reply");
      }
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
    }
  },
);
