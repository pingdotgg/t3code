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
  "An unsaved queued edit keeps its thread mention when the queued run starts",
  WEB,
  async ({ t3, app, screen }) => {
    const settings = await runPromise(threadRuntimeSettings);
    try {
      // Supervised mode makes the approval recording wait for an answer, which holds its turn open.
      await runPromise(settings.supervise);
      const project = await t3.project("demo");
      await t3.thread({ project, title: "Release notes", messages: ["Draft the notes"] });
      const thread = await t3.thread({
        project,
        title: "Waiting work",
        messages: ["Change the file"],
        model: "approval",
      });
      const { cli } = makeState(T3_HOME);
      await runPromise(cli(["thread", "send", thread.threadId, "Queued message"]));
      await t3.open(thread);

      await screen.getByRole("button", "Edit queued message").tap();
      const composer = screen.getByRole("textbox");
      await composer.press("End");
      await composer.pressSequentially(" @Release");
      await screen.getByRole("option", "Release notes", { exact: false }).tap();
      await expect(composer).toContainText("Release notes");

      await screen.getByRole("button", "Approve", { exact: true }).tap();
      await expect(screen.getByText("was kept in the composer", { exact: false })).toBeVisible();
      await expect(screen.getByRole("button", "Cancel editing queued message")).not.toBeVisible();
      await app.screenshot("recovered-edit");
      await expect(composer).toContainText("Release notes");
    } finally {
      await runPromise(settings.restore);
    }
  },
);
