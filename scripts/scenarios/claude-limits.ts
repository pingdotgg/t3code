// Turns on a Claude instance whose CLI reports the Fable weekly bucket spent and the
// account-wide weekly at 42%. The fake answers only the probe, so no turn reaches a model.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise } from "./t3.ts";

interface Selection {
  readonly instanceId: string;
  readonly model: string;
}

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const SettingsFile = Schema.fromJsonString(JsonRecord);
const decodeSettings = Schema.decodeEffect(SettingsFile);
const encodeSettings = Schema.encodeEffect(SettingsFile);
const decodeRecord = Schema.decodeUnknownEffect(JsonRecord);

/** The server watches its settings file, so this applies without a restart. */
export const useClaudeWithFableSpent = (input: {
  readonly defaultModel: Selection;
  readonly fallbackModel: Selection;
}) =>
  runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const settingsPath = path.join(T3_HOME, "userdata/settings.json");
      const settings = yield* decodeSettings(yield* fs.readFileString(settingsPath));
      const providerInstances = yield* decodeRecord(settings.providerInstances);
      const fakeClaude = path.join(
        yield* path.fromFileUrl(new URL(".", import.meta.url)),
        "fixtures/claude-fable-spent.mjs",
      );
      const claudeAgent = {
        driver: "claudeAgent",
        enabled: true,
        config: { binaryPath: fakeClaude },
      };
      yield* fs.writeFileString(
        settingsPath,
        yield* encodeSettings({
          ...settings,
          providerInstances: { ...providerInstances, claudeAgent },
          defaultModelSelection: input.defaultModel,
          fallbackModelSelection: input.fallbackModel,
        }),
      );
    }),
  );
