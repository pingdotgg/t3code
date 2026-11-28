import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);

const threadRuntimeSettings = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const settingsPath = (yield* Path.Path).join(T3_HOME, "userdata/settings.json");
  const original = yield* fs.readFileString(settingsPath);
  const settings = yield* decodeSettings(original);
  return {
    supervise: fs.writeFileString(
      settingsPath,
      yield* encodeSettings({ ...settings, defaultRuntimeMode: "approval-required" }),
    ),
    restore: fs.writeFileString(settingsPath, original),
  };
});

test(
  "A queued message runs with the model chosen while editing it",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const settings = await runPromise(threadRuntimeSettings);
    try {
      await runPromise(settings.supervise);
      const project = await t3.project("demo");
      const thread = await t3.thread({
        project,
        title: "Queued model",
        messages: ["Change the file"],
        model: "approval",
      });
      const { cli } = makeState(T3_HOME);
      await runPromise(cli(["thread", "send", thread.threadId, "Queued message"]));
      await t3.open(thread);
      await screen.getByRole("button", "Edit queued message").tap();
      await browser.locator("[data-chat-provider-model-picker-label]").first().tap();
      await browser.keyboard.type("Showcase");
      await browser.keyboard.press("Enter");
      await browser.keyboard.press("Escape");
      await screen.getByRole("button", "Update queued message", { exact: false }).tap();
      await screen.getByRole("button", "Approve", { exact: true }).tap();
      await expect
        .poll(async () => {
          const shown = await runPromise(cli(["thread", "show", thread.threadId, "--json"]));
          const result = JSON.parse(shown.stdout) as {
            thread: { model: string };
            messages: Array<{ text: string }>;
          };
          return result.messages.some((message) => message.text === "Queued message")
            ? result.thread.model
            : null;
        })
        .toBe("showcase");
      await app.screenshot("queued-model");
    } finally {
      await runPromise(settings.restore);
    }
  },
);
