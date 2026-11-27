// @effect-diagnostics nodeBuiltinImport:off -- The scenario stages a local ACP executable.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

// The agent drops "model-a" from its model list after its first reply, as an agent that lost its
// network can, and offers it again once the scenario creates the online flag. Each agent process
// names its own session, so a reply says which native session answered it.
const ACP = `
import { existsSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";

const onlineFlag = process.argv[2];
const sessionId = "session-" + process.pid;
let prompts = 0;
const modelOption = (online) => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: online ? "model-a" : "model-b",
  options: online
    ? [{ value: "model-a", name: "Model A" }, { value: "model-b", name: "Model B" }]
    : [{ value: "model-b", name: "Model B" }],
});
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const respond = (id, result) => send({ id, result });
const update = (update) => send({ method: "session/update", params: { sessionId, update } });
const watcher = watch(dirname(onlineFlag), (_event, name) => {
  if (name !== basename(onlineFlag) || !existsSync(onlineFlag)) return;
  watcher.close();
  update({ sessionUpdate: "config_option_update", configOptions: [modelOption(true)] });
});
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    respond(id, { protocolVersion: 1, agentInfo: { name: "refusing-agent", version: "1.0.0" }, agentCapabilities: {}, authMethods: [] });
  } else if (method === "session/new") {
    respond(id, { sessionId, configOptions: [modelOption(true)] });
  } else if (method === "session/set_config_option") {
    respond(id, { configOptions: [modelOption(true)] });
  } else if (method === "session/prompt") {
    prompts += 1;
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: sessionId + " answered prompt " + prompts },
    });
    // The first reply ends with the agent no longer offering the thread's model.
    if (prompts === 1) update({ sessionUpdate: "config_option_update", configOptions: [modelOption(false)] });
    respond(id, { stopReason: "end_turn" });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "An ACP agent that refuses the model keeps its native session for the next message",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const script = NodePath.join(project, "refusing-acp.mjs");
    const onlineFlag = NodePath.join(project, "online.flag");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(originalSettings);
    await NodeFSP.writeFile(script, ACP);
    settings.providerInstances["refusing-agent"] = {
      driver: "acpRegistry",
      displayName: "Refusing Agent",
      enabled: true,
      config: { source: "local", commandPath: process.execPath, commandArgs: [script, onlineFlag] },
    };
    try {
      await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));
      // The settings watcher registers the agent asynchronously; start once the server lists it.
      await runPromise(
        Effect.gen(function* () {
          const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
          yield* client.subscribeServerConfig({}).pipe(
            Stream.filter((event) =>
              (event.type === "snapshot"
                ? event.config.providers
                : event.type === "providerStatuses"
                  ? event.payload.providers
                  : []
              ).some((provider) => provider.instanceId === "refusing-agent"),
            ),
            Stream.runHead,
          );
        }).pipe(Effect.scoped),
      );
      const { cli } = makeState(T3_HOME);
      type Run = { threadId: string; status: string; reply: string | null; error: string | null };
      const refusedModel = (run: Run) =>
        run.status === "failed" && (run.error ?? "").includes('did not accept the model "model-a"');
      const send = async (threadId: string, text: string): Promise<Run> => {
        const sent = await runPromise(
          cli(["thread", "send", threadId, text, "--wait", "--json"], [0, 1]),
        );
        return JSON.parse(sent.stdout) as Run;
      };
      const started = await runPromise(
        cli(
          [
            "thread",
            "start",
            project,
            "First request",
            "--title",
            "Refused model",
            "--provider",
            "refusing-agent",
            "--model",
            "model-a",
            "--wait",
            "--json",
          ],
          [0, 1],
        ),
      );
      const first = JSON.parse(started.stdout) as Run;
      if (first.status !== "completed" || first.reply === null) {
        throw new Error(`The first turn did not complete: ${JSON.stringify(first)}`);
      }
      const session = first.reply.split(" ")[0];

      // Two messages while the agent no longer offers the model: both are refused before a prompt.
      for (const text of ["Second request", "Third request"]) {
        const refused = await send(first.threadId, text);
        if (!refusedModel(refused)) {
          throw new Error(`The agent was expected to refuse the model: ${JSON.stringify(refused)}`);
        }
      }

      // The composer names the model only once the server has the agent's model list offering it,
      // which the server publishes after updating the list the next turn start checks.
      await t3.open({ threadId: first.threadId });
      const modelLabel = browser.locator("[data-chat-provider-model-picker-label]").first();
      await NodeFSP.writeFile(onlineFlag, "online");
      await expect(modelLabel).toHaveText("Model A", { timeout: 30_000 });
      const last = await send(first.threadId, "Fourth request");
      if (last.status !== "completed") {
        throw new Error(`The fourth request did not complete: ${JSON.stringify(last)}`);
      }

      const reply = screen.getByText(/answered prompt/).last();
      await reply.waitFor({ timeout: 60_000 });
      try {
        // The refused messages never reached the agent, so the same session answers its second prompt.
        await expect(reply).toHaveText(`${session} answered prompt 2`);
      } finally {
        await app.screenshot("reply-after-refused-model");
      }
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
    }
  },
);
