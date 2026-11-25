import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { LATHE_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./lathe.ts";

const PREFIX = "Codex CLI command failed: ";
const KEPT = `${PREFIX}${"The title model refused this request. ".repeat(10)}`.slice(0, 298);
// The emoji's two UTF-16 units straddle unit 299, where the server cuts the failure message.
const FAKE_CODEX = `#!/bin/sh
printf '%s\\n' '${KEPT.slice(PREFIX.length)}😀 and the rest of the error' >&2
exit 1
`;

test(
  "A long title regeneration failure ends without a broken character",
  WEB,
  async ({ lathe, app, browser, screen }) => {
    const { fakeCodex, settingsPath, originalSettings } = await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return {
          fakeCodex: path.join(LATHE_HOME, "bin/fake-codex"),
          settingsPath: path.join(LATHE_HOME, "userdata/settings.json"),
          originalSettings: yield* fs.readFileString(
            path.join(LATHE_HOME, "userdata/settings.json"),
          ),
        };
      }),
    );
    const settings = JSON.parse(originalSettings);
    settings.providerInstances.codex = {
      driver: "codex",
      enabled: true,
      config: { binaryPath: fakeCodex },
    };
    const nextSettings = JSON.stringify(settings);
    try {
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(fakeCodex, FAKE_CODEX);
          yield* fs.chmod(fakeCodex, 0o755);
          yield* fs.writeFileString(settingsPath, nextSettings);
        }),
      );

      const project = await lathe.project("demo");
      const thread = await lathe.thread({ project, title: "Earlier work", messages: ["first"] });
      await lathe.open(thread);

      await screen.getByRole("button", "Thread actions for Earlier work").tap();
      await screen.getByRole("menuitem", "Regenerate title").tap();
      await expect(screen.getByText("Failed to regenerate thread title")).toBeVisible();
      // Read the toast once: it closes by itself, and its four-line clamp hides the cut.
      const message = await browser.locator('[data-slot="toast-description"]').textContent();
      await app.screenshot("regenerate-failed");
      expect(message).toBe(`${KEPT}…`);
    } finally {
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(settingsPath, originalSettings);
          yield* fs.remove(fakeCodex, { force: true });
        }),
      );
    }
  },
);
