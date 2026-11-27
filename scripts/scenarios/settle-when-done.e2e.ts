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

const supervisedThreads = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const settingsPath = (yield* Path.Path).join(T3_HOME, "userdata/settings.json");
  const original = yield* fs.readFileString(settingsPath);
  const settings = yield* decodeSettings(original);
  return {
    apply: fs.writeFileString(
      settingsPath,
      yield* encodeSettings({ ...settings, defaultRuntimeMode: "approval-required" }),
    ),
    restore: fs.writeFileString(settingsPath, original),
  };
});

test(
  "A running thread can settle when done, cancel, and settle after its response completes",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const settings = await runPromise(supervisedThreads);
    try {
      await runPromise(settings.apply);
      const project = await t3.project("demo");
      // The Replay approval holds this run open until the scenario approves it.
      const thread = await t3.thread({
        project,
        title: "Waiting work",
        messages: ["Change the file"],
        model: "approval",
      });
      await t3.open(thread);

      const row = screen.getByRole("button", /^Waiting work(?:,|$)/);
      const approve = screen.getByRole("button", "Approve", { exact: true });
      const pending = browser.locator(
        '[data-thread-item] [role="img"][aria-label="Settle when done"]',
      );
      try {
        await approve.waitFor();
      } finally {
        await app.screenshot("running-before-request");
      }
      await row.secondaryTap();
      // Both revisions offer a real action, so main fails on the behavior below.
      await screen.getByRole("menuitem", /^Settle (?:thread|when done)$/).tap();
      try {
        await expect(pending).toBeVisible();
      } finally {
        await app.screenshot("settle-requested");
      }
      await expect(row).toBeVisible();
      await expect(row).not.toHaveAttribute("data-sidebar-parent", "shelf:settled");
      await expect(approve).toBeVisible();

      await row.hover();
      await screen.getByRole("button", "Cancel settle when done", { exact: true }).tap();
      await expect(pending).not.toBeVisible();
      await row.hover();
      const settle = screen.getByRole("button", "Settle when done", { exact: true });
      await expect(settle).toBeVisible();
      await expect(row).not.toHaveAttribute("data-sidebar-parent", "shelf:settled");
      await app.screenshot("settle-canceled");

      await settle.tap();
      await expect(pending).toBeVisible();
      await approve.tap();
      await expect(row).toHaveAttribute("data-sidebar-parent", "shelf:settled");
      await expect(approve).not.toBeVisible();
      await expect(pending).not.toBeVisible();
      await app.screenshot("settled-after-response");
    } finally {
      await runPromise(settings.restore);
    }
  },
);
