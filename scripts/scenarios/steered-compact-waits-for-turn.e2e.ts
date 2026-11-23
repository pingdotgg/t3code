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

test("/compact sent while the agent works waits for the turn", WEB, async ({ t3, app, screen }) => {
  const project = await t3.project("demo");
  // The showcase recording streams for several seconds, long enough to send into its turn.
  const thread = await t3.thread({
    project,
    title: "Long work",
    messages: ["Show me around"],
    model: "showcase",
  });
  await t3.open(thread);

  const composer = screen.getByRole("textbox");
  await composer.tap();
  await composer.pressSequentially("Show me again");
  await composer.press("Enter");
  await expect(screen.getByRole("button", "Stop generation")).toBeVisible();

  // The trailing space closes the slash menu so Enter sends instead of picking a command.
  await composer.pressSequentially("/compact ");
  await composer.press("Enter");
  await app.screenshot("compact-sent");
  await expect(screen.getByRole("button", "Edit queued message")).toBeVisible();

  const settings = await runPromise(threadRuntimeSettings);
  try {
    // An approval holds this turn open, so the queued command stays put while Send now is hovered.
    await runPromise(settings.supervise);
    const waiting = await t3.thread({
      project,
      title: "Waiting work",
      messages: ["Change the file"],
      model: "approval",
    });
    await runPromise(makeState(T3_HOME).cli(["thread", "send", waiting.threadId, "/compact"]));
    await t3.open(waiting);
    await screen.getByRole("button", "Send now").hover();
    await expect(
      screen.getByText("Move this command to the front of the queue", { exact: false }),
    ).toBeVisible();
    await app.screenshot("send-now-tooltip");
  } finally {
    await runPromise(settings.restore);
  }
});
