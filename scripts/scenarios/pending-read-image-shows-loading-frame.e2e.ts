import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const AGENT = "pending-read-agent";
const SCRIPT = "pending-read-acp.mjs";
const IMAGE = "later.png";
const REPLY = "The screenshot is a blue frame.";
// A 320x180 blue PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAABk0lEQVR42u3TAQkAAAzDsGm53fu8jusYBKKg0MweUCoSgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGA6sABgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAgIHBwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMBlYBDAwYGDAwGBgwMGBgwMBgYMDAgIHBwICBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQNDtwcYFke/eepCNQAAAABJRU5ErkJggg==";

// Like an agent that takes a screenshot and reads it in one message: the Read starts before the
// file exists. The agent writes the file once the first gate appears, and ends the turn, which
// folds the strip away, once the second does.
const ACP = `
import { unwatchFile, watchFile, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [image, writeGate, replyGate] = process.argv.slice(2);
const sessionId = "pending-read-image";
const released = (gate) =>
  new Promise((resolve) => {
    watchFile(gate, { interval: 100 }, (stat) => {
      if (stat.nlink === 0) return;
      unwatchFile(gate);
      resolve();
    });
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
    update({ sessionUpdate: "tool_call", toolCallId: "read", kind: "read", title: "Read", status: "in_progress", rawInput: { path: image } });
    await released(writeGate);
    writeFileSync(image, Buffer.from(${JSON.stringify(PNG)}, "base64"));
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Read image" } }],
    });
    await released(replyGate);
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${JSON.stringify(REPLY)} } });
    send({ id, result: { stopReason: "end_turn" } });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);

/** Registers the scripted agent and waits until the server lists it. */
const stageAgent = Effect.fn("scenario.stagePendingReadAgent")(function* (
  project: string,
  origin: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsPath = path.join(T3_HOME, "userdata/settings.json");
  const original = yield* fs.readFileString(settingsPath);
  const settings = yield* decodeSettings(original);
  const writeGate = path.join(project, "write-image");
  const replyGate = path.join(project, "reply");
  yield* fs.writeFileString(
    settingsPath,
    yield* encodeSettings({
      ...settings,
      providerInstances: {
        ...(settings.providerInstances as Record<string, unknown>),
        [AGENT]: {
          driver: "acpRegistry",
          displayName: "Pending read agent",
          enabled: true,
          config: {
            source: "local",
            commandPath: yield* HostProcess.ExecutablePath,
            commandArgs: [
              path.join(project, SCRIPT),
              path.join(project, IMAGE),
              writeGate,
              replyGate,
            ],
          },
        },
      },
    }),
  );
  // The settings watcher registers the agent asynchronously.
  const client = yield* rpcClient(T3_HOME, origin);
  yield* client.subscribeServerConfig({}).pipe(
    Stream.filter((event) =>
      (event.type === "snapshot"
        ? event.config.providers
        : event.type === "providerStatuses"
          ? event.payload.providers
          : []
      ).some((provider) => provider.instanceId === AGENT),
    ),
    Stream.runHead,
  );
  return {
    writeImage: fs.writeFileString(writeGate, ""),
    reply: fs.writeFileString(replyGate, ""),
    restore: fs.writeFileString(settingsPath, original),
  };
}, Effect.scoped);

test(
  "An image a running Read is opening shows a loading frame, not Image unavailable, then the image",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo", { [SCRIPT]: ACP });
    const agent = await runPromise(stageAgent(project, app.baseUrl ?? ""));
    try {
      const started = await runPromise(
        makeState(T3_HOME).cli([
          "thread",
          "start",
          project,
          "Take a screenshot and look at it",
          "--title",
          "Pending read",
          "--provider",
          AGENT,
          "--model",
          "default",
          "--json",
        ]),
      );
      const { threadId } = JSON.parse(started.stdout) as { threadId: string };

      await t3.open({ threadId });
      // The strip's frame shows either state; the bug is which one it is while the Read runs.
      const frame = browser.locator('[data-image-gallery] :is([role="status"], [role="alert"])');
      await frame.first().waitFor({ timeout: 60_000 });
      await app.screenshot("while-reading");
      await expect(frame).toHaveAttribute("aria-label", "Loading image");

      await runPromise(agent.writeImage);
      await screen.getByRole("button", `Preview ${IMAGE}`).waitFor({ timeout: 30_000 });
      await app.screenshot("after-read");
    } finally {
      await runPromise(agent.reply.pipe(Effect.ensuring(Effect.ignore(agent.restore))));
    }
  },
);
