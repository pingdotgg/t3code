import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const PLAN = "```md\n```\u00a0\n# Sample heading\n```\n\n# Release plan\n\nRun a smoke check.";
const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);
const ACP = `
import { createInterface } from "node:readline";

const sessionId = "proposed-plan-scenario";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const update = (update) => send({ method: "session/update", params: { sessionId, update } });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 2, info: { name: "plan-agent", version: "1.0.0" } } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId } });
  } else if (method === "session/prompt") {
    update({ sessionUpdate: "plan_update", plan: { type: "markdown", planId: "release", content: ${JSON.stringify(PLAN)} } });
    update({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
    send({ id, result: {} });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "A proposed plan title skips sample headings inside code fences",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", { "plan-agent.mjs": ACP });
    const restoreSettings = await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const settingsPath = path.join(T3_HOME, "userdata/settings.json");
        const original = yield* fs.readFileString(settingsPath);
        const settings = yield* decodeSettings(original);
        const planAgent = {
          driver: "acpRegistry",
          displayName: "Plan Agent",
          enabled: true,
          config: {
            source: "local",
            commandPath: process.execPath,
            commandArgs: [path.join(project, "plan-agent.mjs")],
          },
        };
        const providerInstances = {
          ...(settings.providerInstances as object),
          "plan-agent": planAgent,
        };
        yield* fs.writeFileString(
          settingsPath,
          yield* encodeSettings({ ...settings, providerInstances }),
        );
        return fs.writeFileString(settingsPath, original);
      }),
    );

    try {
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
              ).some((provider) => provider.instanceId === "plan-agent"),
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
          "Propose the release plan.",
          "--title",
          "Release",
          "--provider",
          "plan-agent",
          "--model",
          "default",
          "--wait",
          "--json",
        ]),
      );
      const { threadId } = JSON.parse(started.stdout) as { threadId: string };
      await t3.open({ threadId });
      await screen.getByRole("button", "Plan actions").waitFor();
      await app.screenshot("proposed-plan-title");
      await expect(browser.locator("h3[data-thread-find-text]")).toHaveText("Release plan");
    } finally {
      await runPromise(restoreSettings);
    }
  },
);
