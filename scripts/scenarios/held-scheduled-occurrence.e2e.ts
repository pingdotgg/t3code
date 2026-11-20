import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

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
  "A recurring task reports when its queued occurrence is held",
  WEB,
  async ({ t3, app, screen }) => {
    const settings = await runPromise(threadRuntimeSettings);
    try {
      // Supervised mode makes the approval recording wait for an answer, which holds its turn open.
      await runPromise(settings.supervise);
      const project = await t3.project("scheduled-hold");
      await t3.thread({ project, title: "Earlier work", messages: ["Start"] });
      const thread = await t3.thread({
        project,
        title: "Waiting scheduled thread",
        messages: ["Ask a question"],
        model: "approval",
      });

      await t3.open("/settings/scheduled-tasks");
      await screen.getByRole("button", "New task").tap();
      await screen.getByRole("textbox", "Name").fill("Held recurring task");
      await screen.getByRole("combobox", "Destination").tap();
      await screen.getByRole("option", "One thread, continuing the conversation").tap();
      await screen.getByRole("combobox", "Destination thread").tap();
      await screen.getByRole("option", "Waiting scheduled thread").tap();
      await screen.getByRole("textbox", "Prompt").fill("Scheduled check prompt");
      await screen.getByRole("button", "Every interval").tap();
      await screen.getByRole("spinbutton", "Run every").fill("1");
      await screen.getByRole("button", "Create task").tap();

      await t3.open(thread);
      await screen.getByRole("button", "Approve", { exact: true }).waitFor();
      await screen
        .getByRole("button", "Automation Held recurring task")
        .waitFor({ timeout: 100_000 });
      // Stopping the active turn holds the queued scheduled occurrence.
      await screen.getByRole("button", "Stop generation").tap();
      await screen.getByRole("button", "Resume thread").waitFor();
      await screen.getByRole("button", "Edit queued message").waitFor();

      await app.open("/settings/scheduled-tasks");
      await expect(
        screen.getByText(
          "A previous occurrence is held in the thread queue. Resume or remove it to run this task again.",
        ),
      ).toBeVisible({ timeout: 100_000 });
      await app.screenshot("held-scheduled-task");
    } finally {
      await runPromise(settings.restore);
    }
  },
);
