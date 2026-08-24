import * as NodeServices from "@effect/platform-node/NodeServices";
import { AntigravitySettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildInitialAntigravityProviderSnapshot,
  checkAntigravityProviderStatus,
} from "./AntigravityProvider.ts";

const decodeSettings = Schema.decodeSync(AntigravitySettings);

describe("buildInitialAntigravityProviderSnapshot", () => {
  it.effect("advertises plan mode and in-session model changes", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAntigravityProviderSnapshot(decodeSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.showInteractionModeToggle).toBe(true);
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      expect(snapshot.badgeLabel).toBe("Early Access");
    }),
  );
});

it.layer(NodeServices.layer)("checkAntigravityProviderStatus", (it) => {
  it.effect("discovers the authenticated TSV model catalog", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-antigravity-provider-",
          });
          const binary = path.join(directory, "agy");
          yield* fileSystem.writeFileString(
            binary,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then',
              '  printf "agy 1.1.12\\n"',
              'elif [ "$1" = "models" ]; then',
              '  printf "gemini-3.6-flash-high\\tGemini 3.6 Flash (High)\\n"',
              '  printf "gemini-3.6-flash-medium\\tGemini 3.6 Flash (Medium)\\n"',
              '  printf "gemini-3.6-flash-low\\tGemini 3.6 Flash (Low)\\n"',
              "else",
              "  exit 2",
              "fi",
              "",
            ].join("\n"),
          );
          yield* fileSystem.chmod(binary, 0o755);
          return yield* checkAntigravityProviderStatus(
            decodeSettings({ binaryPath: binary }),
            process.env,
            directory,
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.version).toBe("1.1.12");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["gemini-3.6-flash"]);
    }),
  );

  it.effect("reports a missing binary without exposing process details", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityProviderStatus(
        decodeSettings({ binaryPath: "/definitely/not-installed/agy" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("not installed");
    }),
  );
});
