import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

// Windows Volta 2 writes `bin/<tool>` scripts that run `volta run`, not links to `volta-shim`.
// The fake `volta` only reports a version, so nothing installs or reaches a model. The latest
// version comes from npm's registry through the host's npm, which the server finds first on PATH.
const VOLTA_SCRIPT_SHIM = '#!/bin/bash\nvolta run "$(basename $0)" "$@"\n';
const FAKE_VOLTA = '#!/bin/sh\n[ "$1 $3" = "run --version" ] && echo 2.1.2 && exit 0\nexit 1\n';

const SettingsJson = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({ providerInstances: Schema.Record(Schema.String, Schema.Unknown) }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
);

const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);

const installVoltaOpenCode = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const voltaHome = path.join(T3_HOME, "Volta");
  const shim = path.join(voltaHome, "bin", "opencode");
  const executable = (file: string, text: string) =>
    fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(file, text)), Effect.andThen(fs.chmod(file, 0o755)));
  yield* executable(shim, VOLTA_SCRIPT_SHIM);
  yield* fs.makeDirectory(path.join(voltaHome, "tools", "image", "packages", "@opencode", "cli"), {
    recursive: true,
  });
  // The scenario home's `bin` is on the server's PATH.
  yield* executable(path.join(T3_HOME, "bin", "volta"), FAKE_VOLTA);

  const settingsPath = path.join(T3_HOME, "userdata", "settings.json");
  const settings = yield* decodeSettings(yield* fs.readFileString(settingsPath));
  const opencode = { driver: "opencode", enabled: true, config: { binaryPath: shim } };
  yield* fs.writeFileString(
    settingsPath,
    yield* encodeSettings({
      ...settings,
      providerInstances: { ...settings.providerInstances, opencode },
    }),
  );
});

test(
  "OpenCode installed through a Volta script shim offers a Volta update",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await browser.emulateMedia({ colorScheme: "dark" });
    await t3.project("demo");
    await runPromise(installVoltaOpenCode);
    await t3.open("/settings/providers?instanceId=opencode");

    // The list row and the detail header both carry the button; take the header's.
    const details = screen.getByRole("button", /view details/).last();
    await expect(details).toBeVisible({ timeout: 60_000 });
    await details.tap();
    await expect(screen.getByRole("dialog", "Update available")).toBeVisible();
    // Capture the settled popover, not its fade-in.
    await browser.evaluate(() => {
      const popover = document.querySelector('[role="dialog"][aria-label="Update available"]');
      for (const animation of popover?.getAnimations({ subtree: true }) ?? []) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
      }
      return null;
    });
    await app.screenshot("update-details");
    await expect(screen.getByText("volta install @opencode/cli@latest")).toBeVisible();
  },
);
