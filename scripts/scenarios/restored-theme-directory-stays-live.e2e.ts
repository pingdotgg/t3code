import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "Appearance reflects new edits after the environment theme directory is restored",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("theme-directory");
    const themes = `${T3_HOME}/userdata/themes`;
    const previous = `${T3_HOME}/themes-before-restore`;
    const restored = `${T3_HOME}/themes-to-restore`;
    const file = "restore-fixture.json";
    const contents = (name: string) =>
      JSON.stringify({
        version: 1,
        name,
        appearance: "dark",
        colors: { canvas: "#171820", accent: "#7aa2f7" },
      });
    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${themes}/${file}`, contents("Original Palette"));
        yield* fs.makeDirectory(restored);
        yield* fs.writeFileString(`${restored}/${file}`, contents("Restored Palette"));
      }),
    );
    try {
      await t3.open("/settings/appearance");
      await screen.getByRole("button", "Use Original Palette theme", { exact: true }).waitFor();
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.rename(themes, previous);
          yield* fs.rename(restored, themes);
        }),
      );
      // Wait for the rename event to be reflected before editing the replacement directory.
      const restoredTheme = screen.getByRole("button", "Use Restored Palette theme", {
        exact: true,
      });
      await restoredTheme.waitFor();
      await restoredTheme.scrollIntoView();

      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(`${themes}/${file}`, contents("Edited Restored Palette")),
        ),
      );
      try {
        await expect(
          screen.getByRole("button", "Use Edited Restored Palette theme", { exact: true }),
        ).toBeVisible();
      } finally {
        await app.screenshot("appearance-after-editing-restored-theme");
      }
    } finally {
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          if (yield* fs.exists(previous)) {
            yield* fs.remove(themes, { recursive: true, force: true });
            yield* fs.rename(previous, themes);
          }
          yield* fs.remove(`${themes}/${file}`, { force: true });
          yield* fs.remove(restored, { recursive: true, force: true });
        }),
      );
    }
  },
);
