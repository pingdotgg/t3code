// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off - the scenario seeds an 8 MB file and rewrites settings.json as the repro wrote it.
import * as NodeCrypto from "node:crypto";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const decodeSettings = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

test(
  "Cleanup updates the displayed size of a kept worktree",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("cleanup-size", { "README.md": "Example project" });
    const settingsPath = `${T3_HOME}/userdata/settings.json`;
    const original = await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(settingsPath)),
    );
    const worktree = `${T3_HOME}/worktrees/cleanup-size-orphan`;
    const build = `${worktree}/build`;
    const git = (...args: ReadonlyArray<string>) => runPromise(run("git", args, { cwd: project }));
    await git("worktree", "add", "--detach", worktree, "HEAD");
    try {
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(build);
          yield* fs.writeFile(`${build}/bundle.js`, NodeCrypto.randomBytes(8 * 1024 * 1024));
          yield* fs.utimes(worktree, 1, 1);
          yield* fs.writeFileString(
            settingsPath,
            JSON.stringify({
              ...decodeSettings(original),
              storageCleanup: { worktreeOnDelete: true },
            }),
          );
        }),
      );

      await t3.open("/settings/maintenance");
      const runCleanup = screen.getByRole("button", "Delete now", { exact: true });
      await runCleanup.tap();
      await screen.getByRole("button", /^Last run/).tap();
      await screen.getByText(/^8\.\d{2} MB$/).waitFor();
      const orphanRow = browser
        .locator('#storage-cleanup-last-run [data-slot="settings-row"]')
        .filter({ has: screen.getByText(worktree, { exact: true }) });
      await orphanRow.getByText(/^8\.\d{2} MB$/).waitFor();

      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(`${build}/bundle.js`);
        }),
      );
      await runCleanup.tap();
      await runCleanup.waitFor();
      await screen.getByText("No thread uses this worktree", { exact: true }).scrollIntoView();
      try {
        await expect(orphanRow.getByText(/^\d+(?:\.\d+)? KB$/)).toBeVisible();
        await expect(browser.locator("#storage-cleanup-last-run")).toContainText(
          /\b\d+(?:\.\d+)? KB\b/,
        );
      } finally {
        await app.screenshot("kept-worktree-after-build-file-removal");
      }
    } finally {
      await git("worktree", "remove", "--force", worktree);
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(settingsPath, original)),
      );
    }
  },
);
