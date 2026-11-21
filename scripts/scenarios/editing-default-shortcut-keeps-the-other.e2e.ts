import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

test(
  "Editing one inherited shortcut keeps the other shortcut for the same command",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("inherited-shortcuts");
    const { keybindingsConfigPath } = await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
        return yield* client["server.getConfig"]({});
      }).pipe(Effect.scoped),
    );
    const original = await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(keybindingsConfigPath)),
    );

    try {
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(keybindingsConfigPath, "[]\n"),
        ),
      );
      await t3.open("/settings/keybindings");
      const search = screen.getByLabel("Search keybindings");
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
          fs.writeFileString(keybindingsConfigPath, original),
        ),
      );
    }
  },
);
