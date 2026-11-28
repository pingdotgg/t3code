import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

// Another CLI at the Codex binary path: a version-looking line for `--version`, and plain text
// (not app-server JSON) for everything else. The process stays up, as a wrapper's would.
const NON_CODEX =
  '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "noop v1.2.3"; exit 0; fi\necho "noop: a wrapper, not Codex"\ncat > /dev/null\n';

const SettingsJson = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({ providerInstances: Schema.Record(Schema.String, Schema.Unknown) }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
);

const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);

const pointCodexAtNonCodex = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const binary = path.join(T3_HOME, "noop-codex");
  yield* fs.writeFileString(binary, NON_CODEX);
  yield* fs.chmod(binary, 0o755);

  const settingsPath = path.join(T3_HOME, "userdata", "settings.json");
  const settings = yield* decodeSettings(yield* fs.readFileString(settingsPath));
  const codex = { driver: "codex", enabled: true, config: { binaryPath: binary } };
  yield* fs.writeFileString(
    settingsPath,
    yield* encodeSettings({
      ...settings,
      providerInstances: { ...settings.providerInstances, codex },
    }),
  );
});

test(
  "Codex pointed at a non-Codex binary names the path instead of an opaque protocol error",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("demo");
    await runPromise(pointCodexAtNonCodex);
    await t3.open("/settings/providers?instanceId=codex");

    await expect(screen.getByText("provider probe failed", { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    });
    await app.screenshot("probe-message");
    await expect(
      screen.getByText("did not speak the Codex app-server protocol", { exact: false }).first(),
    ).toBeVisible();
  },
);
