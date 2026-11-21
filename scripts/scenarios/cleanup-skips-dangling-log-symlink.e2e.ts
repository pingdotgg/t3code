import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

const decodeSettings = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

test(
  "Cleanup removes expired rotated logs even with a dangling symlink in the log directory",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("rotated-log-cleanup");
    const settingsPath = `${T3_HOME}/userdata/settings.json`;
    const logFixture = `${T3_HOME}/userdata/logs/00-cleanup-fixture`;
    const expiredLog = `${logFixture}/server.log.1`;
    const original = await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(settingsPath)),
    );

    try {
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(
            settingsPath,
            JSON.stringify({ ...decodeSettings(original), storageCleanup: { logsAfterDays: 7 } }),
          ),
        ),
      );
      await t3.open("/settings/maintenance");
      await screen.getByLabel("Delete old rotated logs in days").waitFor();

      const deleteNow = screen.getByRole("button", "Delete now", { exact: true });
      await deleteNow.tap();
      await screen.getByRole("button", "Deleting…", { exact: true }).waitFor({ state: "hidden" });
      await screen.getByRole("button", /^Last run/).tap();
      const logsResult = browser
        .locator('#storage-cleanup-last-run [data-slot="settings-row"]')
        .filter({ has: screen.getByText("Rotated logs", { exact: true }) });
      await logsResult.getByText("No expired files", { exact: true }).waitFor();

      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(logFixture);
          yield* fs.symlink(`${logFixture}/missing.log`, `${logFixture}/00-dangling.log.1`);
          yield* fs.writeFileString(expiredLog, "Expired log");
          yield* fs.utimes(expiredLog, 1, 1);
        }),
      );

      await deleteNow.tap();
      await logsResult.scrollIntoView();
      try {
        await expect(logsResult).toContainText("Removed 1 rotated logs");
      } finally {
        await app.screenshot("rotated-log-cleanup-result");
      }
    } finally {
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(logFixture, { recursive: true, force: true });
          yield* fs.writeFileString(settingsPath, original);
        }),
      );
    }
  },
);
