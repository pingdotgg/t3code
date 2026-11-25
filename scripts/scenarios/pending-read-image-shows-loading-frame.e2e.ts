// @effect-diagnostics nodeBuiltinImport:off -- The scenario stages a local ACP executable.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const REPLY = "The screenshot is a blue frame.";
// A 320x180 blue PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAABk0lEQVR42u3TAQkAAAzDsGm53fu8jusYBKKg0MweUCoSgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGA6sABgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAgIHBwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMBlYBDAwYGDAwGBgwMGBgwMBgYMDAgIHBwICBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQNDtwcYFke/eepCNQAAAABJRU5ErkJggg==";

// Like an agent that takes a screenshot and reads it in one message: the Read starts before
// the file exists, and the file appears while the Read is still running. The agent waits for
// the test's go-ahead before writing the file and again before ending the turn, which folds the
// strip away.
const acp = (path: string, signals: string) => `
import { existsSync, watch, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const sessionId = "pending-read-image";
const path = ${JSON.stringify(path)};
const signals = ${JSON.stringify(signals)};
const waitFor = (signal) =>
  new Promise((resolve) => {
    const watcher = watch(signals, (_event, name) => {
      if (name !== signal) return;
      watcher.close();
      resolve();
    });
    if (existsSync(signals + "/" + signal)) {
      watcher.close();
      resolve();
    }
  });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const update = (value) => send({ method: "session/update", params: { sessionId, update: value } });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId } });
  } else if (method === "session/prompt") {
    update({ sessionUpdate: "tool_call", toolCallId: "read", kind: "read", title: "Read", status: "in_progress", rawInput: { path } });
    await waitFor("write-image");
    writeFileSync(path, Buffer.from(${JSON.stringify(PNG)}, "base64"));
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Read image" } }],
    });
    await waitFor("reply");
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${JSON.stringify(REPLY)} } });
    send({ id, result: { stopReason: "end_turn" } });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "An image a running Read is opening shows a loading frame, not Image unavailable, then the image",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const script = NodePath.join(project, "pending-read-acp.mjs");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(originalSettings);
    const signals = await NodeFSP.mkdtemp(NodePath.join(T3_HOME, "pending-read-"));
    await NodeFSP.writeFile(script, acp(NodePath.join(project, "later.png"), signals));
    settings.providerInstances["pending-read-agent"] = {
      driver: "acpRegistry",
      displayName: "Pending read agent",
      enabled: true,
      config: { source: "local", commandPath: process.execPath, commandArgs: [script] },
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
              ).some((provider) => provider.instanceId === "pending-read-agent"),
            ),
            Stream.runHead,
          );
        }).pipe(Effect.scoped),
      );
      const { cli } = makeState(T3_HOME);
      const started = await runPromise(
        cli([
          "thread",
          "start",
          project,
          "Take a screenshot and look at it",
          "--title",
          "Pending read",
          "--provider",
          "pending-read-agent",
          "--model",
          "default",
          "--json",
        ]),
      );
      const { threadId } = JSON.parse(started.stdout) as { threadId: string };

      await t3.open({ threadId });
      await screen.getByText("Read demo/later.png", { exact: true }).waitFor({ timeout: 60_000 });
      // The strip's frame shows either state; the bug is which one it is while the Read runs.
      const frame = browser.locator('[data-image-gallery] :is([role="status"], [role="alert"])');
      await frame.first().waitFor({ timeout: 10_000 });
      await app.screenshot("while-reading");
      await expect(frame).toHaveAttribute("aria-label", "Loading image");

      await NodeFSP.writeFile(NodePath.join(signals, "write-image"), "");
      await screen.getByRole("button", "Preview later.png").waitFor({ timeout: 30_000 });
      await app.screenshot("after-read");
      await NodeFSP.writeFile(NodePath.join(signals, "reply"), "");
      await screen.getByText(REPLY, { exact: true }).waitFor({ timeout: 30_000 });
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
    }
  },
);
