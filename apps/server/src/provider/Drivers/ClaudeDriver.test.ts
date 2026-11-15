// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { makeClaudeMaintenanceResolver as makeClaudeDriverMaintenanceResolver } from "./ClaudeMaintenance.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.layer(NodeServices.layer)("ClaudeDriver maintenance", (it) => {
  it.effect.skipIf(windowsHost)(
    "unwraps the marked CMUX Claude shim before proving native ownership",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-cmux-" });
        const shimRoot = NodePath.join(tempDir, "cmux-cli-shims", "session");
        const shimPath = NodePath.join(shimRoot, "claude");
        const nativeBinDir = NodePath.join(tempDir, ".local", "bin");
        const nativePath = NodePath.join(nativeBinDir, "claude");
        // Only a launcher linked into the versions directory proves a native install.
        const versionsDir = NodePath.join(tempDir, ".local", "share", "claude", "versions");
        const versionPath = NodePath.join(versionsDir, "2.0.0");
        yield* fs.makeDirectory(shimRoot, { recursive: true });
        yield* fs.makeDirectory(nativeBinDir, { recursive: true });
        yield* fs.makeDirectory(versionsDir, { recursive: true });
        yield* fs.writeFileString(shimPath, "#!/bin/sh\n");
        yield* fs.writeFileString(versionPath, "#!/bin/sh\n");
        yield* fs.chmod(shimPath, 0o755);
        yield* fs.chmod(versionPath, 0o755);
        yield* fs.symlink(versionPath, nativePath);

        const env = {
          PATH: [shimRoot, nativeBinDir].join(NodePath.delimiter),
          CMUX_CLAUDE_WRAPPER_SHIM: shimPath,
          CMUX_CLAUDE_WRAPPER_SHIM_ROOT: shimRoot,
        };
        const baseResolver = makePackageManagedProviderMaintenanceResolver({
          provider: ProviderDriverKind.make("claudeAgent"),
          npmPackageName: "@anthropic-ai/claude-code",
          nativeUpdate: {
            args: ["update"],
            isCommandPath: (commandPath) =>
              normalizeCommandPath(commandPath).endsWith("/.local/bin/claude"),
          },
        });
        const before = yield* resolveProviderMaintenanceCapabilitiesEffect(baseResolver, {
          binaryPath: "claude",
          env,
        });
        // Unproven installs fall back to the provider's own updater, but run through the shim.
        const throughShim = {
          executable: shimPath,
          args: ["update"],
          lockKey: "claudeAgent-native",
        };
        expect(before.update).toMatchObject(throughShim);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          makeClaudeDriverMaintenanceResolver(),
          { binaryPath: "claude", env },
        );

        expect(capabilities.update).toMatchObject({
          executable: nativePath,
          args: ["update"],
          lockKey: "claudeAgent-native",
        });

        const unknownWrapper = yield* resolveProviderMaintenanceCapabilitiesEffect(
          makeClaudeDriverMaintenanceResolver(),
          {
            binaryPath: "claude",
            env: {
              ...env,
              CMUX_CLAUDE_WRAPPER_SHIM: NodePath.join(tempDir, "other-wrapper", "claude"),
              CMUX_CLAUDE_WRAPPER_SHIM_ROOT: NodePath.join(tempDir, "other-wrapper"),
            },
          },
        );
        expect(unknownWrapper.update).toBeNull();

        const explicitPath = yield* resolveProviderMaintenanceCapabilitiesEffect(
          makeClaudeDriverMaintenanceResolver(),
          { binaryPath: shimPath, env },
        );
        expect(explicitPath.update).toBeNull();
      }).pipe(Effect.provideService(HostProcess.Platform, "darwin"), Effect.scoped),
  );
});
