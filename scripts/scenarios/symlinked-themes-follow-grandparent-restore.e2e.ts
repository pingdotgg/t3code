import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "Appearance follows edits after restoring a symlinked theme tree",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("symlinked-theme-tree");
    const fixture = `${T3_HOME}/symlinked-theme-tree`;
    const themes = `${T3_HOME}/userdata/themes`;
    const file = "restore-theme-tree.json";
    const active = `${fixture}/active`;
    const restored = `${fixture}/restored`;
    const original = `${fixture}/original-themes`;
    const contents = (name: string) =>
      JSON.stringify({
        version: 1,
        name,
        appearance: "dark",
        colors: { canvas: "#171820", accent: "#7aa2f7" },
      });
    const theme = (name: string) =>
      screen.getByRole("button", `Use ${name} theme`, { exact: true });

    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${themes}/${file}`, contents("Original Tree Palette"));
        for (const tree of [active, restored]) {
          yield* fs.makeDirectory(`${tree}/shared/themes`, { recursive: true });
          yield* fs.writeFileString(
            `${tree}/shared/themes/${file}`,
            contents("Linked Tree Palette"),
          );
        }
      }),
    );

    try {
      await t3.open("/settings/appearance");
      await theme("Original Tree Palette").waitFor();
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.rename(themes, original);
          yield* fs.symlink(`${active}/shared/themes`, themes);
        }),
      );
      const linkedTheme = theme("Linked Tree Palette");
      await linkedTheme.waitFor();
      await linkedTheme.scrollIntoView();

      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.rename(active, `${fixture}/previous`);
          yield* fs.rename(restored, active);
          yield* fs.writeFileString(
            `${active}/shared/themes/${file}`,
            contents("Edited Restored Tree Palette"),
          );
        }),
      );

      try {
        await expect(theme("Edited Restored Tree Palette")).toBeVisible();
      } finally {
        await app.screenshot("appearance-after-editing-restored-theme-tree");
      }
    } finally {
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          if (yield* fs.exists(original)) {
            yield* fs.remove(themes, { recursive: true, force: true });
            yield* fs.rename(original, themes);
          }
          yield* fs.remove(`${themes}/${file}`, { force: true });
          yield* fs.remove(fixture, { recursive: true, force: true });
        }),
      );
    }
  },
);
