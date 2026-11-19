import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect } from "e2e";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);

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
          const random = yield* SecureRandom.SecureRandom;
          yield* fs.writeFile(`${build}/bundle.js`, yield* random.randomBytes(8 * 1024 * 1024));
          yield* fs.utimes(worktree, 1, 1);
          yield* fs.writeFileString(
            settingsPath,
            yield* encodeSettings({
              ...(yield* decodeSettings(original)),
              storageCleanup: { worktreeOnDelete: true },
            }),
          );
        }).pipe(Effect.provide(NodeCrypto.layer)),
      );

      await t3.open("/settings/maintenance");
      const runCleanup = screen.getByRole("button", "Delete now", { exact: true });
      await runCleanup.tap();
      await screen.getByRole("button", /^Last run/).tap();
      await screen.getByText(/^8\.\d{2} MB$/).waitFor();

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
