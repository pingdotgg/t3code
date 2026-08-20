import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ZaiSettings } from "@t3tools/contracts";

import {
  buildInitialZaiProviderSnapshot,
  checkZaiProviderStatus,
} from "./ZaiProvider.ts";
import type { ClaudeCapabilitiesProbe } from "./ClaudeProvider.ts";

const decodeZaiSettings = Schema.decodeSync(ZaiSettings);

describe("buildInitialZaiProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialZaiProviderSnapshot(
        decodeZaiSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — Z.ai is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialZaiProviderSnapshot(decodeZaiSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot with the GLM catalog when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialZaiProviderSnapshot(
        decodeZaiSettings({ enabled: true, customModels: ["glm-custom"] }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.displayName).toBe("Z.ai");
      expect(snapshot.badgeLabel).toBe("Early Access");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "glm-5.3",
        "glm-5.3[1m]",
        "glm-5.2",
        "glm-5.2[1m]",
        "glm-5-turbo",
        "glm-4.7",
        "glm-custom",
      ]);
    }),
  );
});

it.layer(NodeServices.layer)("checkZaiProviderStatus", (it) => {
  it.effect("reports the Claude CLI as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkZaiProviderStatus(
        decodeZaiSettings({
          enabled: true,
          apiKey: "test-key",
          binaryPath: "/definitely/not/installed/claude-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("Claude Code CLI");
    }),
  );

  it.effect("reports unauthenticated when no API key or token env var is set", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-zai-nokey-" });
          const claudePath = path.join(dir, "claude");
          yield* fs.writeFileString(
            claudePath,
            ["#!/bin/sh", 'printf "2.1.0 (Claude Code)\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(claudePath, 0o755);

          return yield* checkZaiProviderStatus(
            decodeZaiSettings({ enabled: true, binaryPath: claudePath }),
            undefined,
            // Explicit empty token so an ambient ANTHROPIC_AUTH_TOKEN on the
            // test machine cannot flip this case.
            { ...process.env, ANTHROPIC_AUTH_TOKEN: "" },
          );
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("Z.ai API key");
    }),
  );

  it.effect("maps an env-token probe to Z.ai auth metadata", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-zai-auth-" });
          const claudePath = path.join(dir, "claude");
          yield* fs.writeFileString(
            claudePath,
            ["#!/bin/sh", 'printf "2.1.0 (Claude Code)\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(claudePath, 0o755);

          const probe: ClaudeCapabilitiesProbe = {
            email: undefined,
            subscriptionType: undefined,
            tokenSource: "ANTHROPIC_AUTH_TOKEN",
            apiProvider: undefined,
            slashCommands: [],
          };
          return yield* checkZaiProviderStatus(
            decodeZaiSettings({ enabled: true, binaryPath: claudePath, apiKey: "test-key" }),
            () => Effect.succeed(probe),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.auth.type).toBe("apiKey");
      expect(snapshot.auth.label).toBe("Z.ai API Key");
    }),
  );

  it.effect("warns when the capabilities probe yields nothing", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-zai-noprobe-" });
          const claudePath = path.join(dir, "claude");
          yield* fs.writeFileString(
            claudePath,
            ["#!/bin/sh", 'printf "2.1.0 (Claude Code)\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(claudePath, 0o755);

          return yield* checkZaiProviderStatus(
            decodeZaiSettings({ enabled: true, binaryPath: claudePath, apiKey: "test-key" }),
            () => Effect.succeed(undefined),
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toContain("Could not verify");
    }),
  );
});
