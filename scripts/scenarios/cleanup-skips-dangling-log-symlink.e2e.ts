import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

test(
  "Cleanup removes expired rotated logs even with a dangling symlink in the log directory",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("rotated-log-cleanup");
    const origin = app.baseUrl ?? "";
    const logFixture = `${T3_HOME}/userdata/logs/00-cleanup-fixture`;
    const expiredLog = `${logFixture}/server.log.1`;
    const originalLogsAfterDays = await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, origin);
        const original = yield* client["server.getSettings"]({});
        yield* client["server.updateSettings"]({ patch: { storageCleanup: { logsAfterDays: 7 } } });
        return original.storageCleanup.logsAfterDays;
      }).pipe(Effect.scoped),
    );

    try {
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
      try {
        await runPromise(
          Effect.flatMap(FileSystem.FileSystem, (fs) =>
            fs.remove(logFixture, { recursive: true, force: true }),
          ),
        );
      } finally {
        await runPromise(
          Effect.gen(function* () {
            const client = yield* rpcClient(T3_HOME, origin);
            yield* client["server.updateSettings"]({
              patch: { storageCleanup: { logsAfterDays: originalLogsAfterDays } },
            });
          }).pipe(Effect.scoped),
        );
      }
    }
  },
);
