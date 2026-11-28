import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "Editing one inherited shortcut keeps the other shortcut for the same command",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("inherited-shortcuts");
    const keybindingsPath = `${T3_HOME}/userdata/keybindings.json`;
    const original = await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(keybindingsPath)),
    );

    try {
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(
            keybindingsPath,
            '[{ "key": "enter", "command": "commandPalette.toggle", "when": "!rightPanelOpen" }]\n',
          ),
        ),
      );
      await t3.open("/settings/keybindings");
      const search = screen.getByLabel("Search keybindings");
      await search.fill("Command Palette");
      await screen
        .getByRole("button", "Edit shortcut for Command Palette: Toggle: Enter")
        .waitFor();

      await search.fill("Chat: New");
      const unchanged = screen.getByRole("button", "Edit shortcut for Chat: New: Ctrl+N", {
        exact: true,
      });
      await unchanged.waitFor();
      await screen.getByRole("button", "Edit shortcut for Chat: New: Ctrl+Shift+O").tap();
      await screen.getByRole("textbox", "Keybinding for Chat: New", { exact: true }).press("F8");
      await screen.getByRole("button", "Save", { exact: true }).tap();
      await screen
        .getByRole("button", "Edit shortcut for Chat: New: F8", { exact: true })
        .waitFor();

      try {
        await expect(unchanged).toBeVisible();
      } finally {
        await app.screenshot("chat-new-shortcuts-after-edit");
      }
    } finally {
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(keybindingsPath, original),
        ),
      );
    }
  },
);
