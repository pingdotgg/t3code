import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { deriveServerPaths } from "../../apps/server/src/config.ts";
import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

const decodeSettings = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

test(
  "Maintenance reflects edits to a symlinked settings file after restoring its directory",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("settings-restore");
    const { settingsPath } = await runPromise(
      deriveServerPaths(T3_HOME, undefined, { baseDirIsExplicit: true }),
    );
    const active = `${T3_HOME}/active-settings`;
    const previous = `${T3_HOME}/old-settings`;
    const restored = `${T3_HOME}/restored-settings`;
    const original = await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readFileString(settingsPath);
      }),
    );
    const settings = decodeSettings(original);
    const contents = (days: number) =>
      JSON.stringify({
        ...settings,
        storageCleanup: { logsAfterDays: days },
      });

    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(active);
        yield* fs.makeDirectory(restored);
        yield* fs.writeFileString(`${active}/settings.json`, contents(5));
        yield* fs.writeFileString(`${restored}/settings.json`, contents(7));
        yield* fs.symlink(`${active}/settings.json`, `${settingsPath}.link`);
        yield* fs.rename(`${settingsPath}.link`, settingsPath);
      }),
    );
    try {
      await t3.open("/settings/maintenance");
      const days = screen.getByLabel("Delete old rotated logs in days");
      await days.scrollIntoView();
      await expect(days).toHaveValue("5");
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(`${active}/settings.json`, contents(7)),
        ),
      );
      await expect(days).toHaveValue("7");

      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.rename(active, previous);
          yield* fs.rename(restored, active);
          yield* fs.writeFileString(`${active}/settings.json`, contents(9));
        }),
      );
      try {
        await expect(days).toHaveValue("9");
        await runPromise(
          Effect.flatMap(FileSystem.FileSystem, (fs) =>
            fs.writeFileString(`${active}/settings.json`, contents(11)),
          ),
        );
        await expect(days).toHaveValue("11");
      } finally {
        await app.screenshot("retention-after-settings-directory-restore");
      }
    } finally {
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(`${settingsPath}.original`, original);
          yield* fs.rename(`${settingsPath}.original`, settingsPath);
          for (const directory of [active, previous, restored]) {
            yield* fs.remove(directory, { recursive: true, force: true });
          }
        }),
      );
    }
  },
);
