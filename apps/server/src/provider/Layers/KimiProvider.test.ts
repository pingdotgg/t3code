// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  type ServerProvider,
  KimiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import {
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
  makeKimiCommandCatalog,
} from "./KimiProvider.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

describe("buildInitialKimiProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(
        decodeKimiSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — Kimi Code is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(decodeKimiSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot with built-in models when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(
        decodeKimiSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Kimi");
      expect(snapshot.displayName).toBe("Kimi Code");
      expect(snapshot.supportsConversationRollback).toBe(false);
      expect(snapshot.showInteractionModeToggle).toBe(true);
      expect(snapshot.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
        ["kimi-code/kimi-for-coding", true],
        ["kimi-code/kimi-for-coding-highspeed", false],
        ["kimi-code/k3", false],
        ["kimi-code/k3-256k", false],
      ]);
    }),
  );
});

it.layer(NodeServices.layer)("checkKimiProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKimiProviderStatus(
        decodeKimiSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/kimi-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  const writeFakeKimiCli = () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-probe-" });
      return writeFakeCli({
        directory: dir,
        name: "kimi",
        source: [
          'if (process.argv[2] === "--version") {',
          '  process.stdout.write("kimi 0.43.1\\n");',
          "  process.exit(0);",
          "}",
          "process.exit(1);",
          "",
        ].join("\n"),
      });
    });

  const kimiEnvironment = (kimiHome: string) => ({ ...process.env, KIMI_CODE_HOME: kimiHome });

  it.effect("reports ready and authenticated when the login token file exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const kimiPath = yield* writeFakeKimiCli();
      const kimiHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-home-" });
      yield* fs.makeDirectory(NodePath.join(kimiHome, "credentials"), { recursive: true });
      yield* fs.writeFileString(
        NodePath.join(kimiHome, "credentials", "kimi-code.json"),
        '{"token":"redacted"}',
      );

      const snapshot = yield* checkKimiProviderStatus(
        decodeKimiSettings({ enabled: true, binaryPath: kimiPath }),
        kimiEnvironment(kimiHome),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.43.1");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Kimi account",
      });
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact"]);
    }),
  );

  it.effect("reports unauthenticated with a login hint when the token file is missing", () =>
    Effect.gen(function* () {
      const kimiPath = yield* writeFakeKimiCli();
      const fs = yield* FileSystem.FileSystem;
      const kimiHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-home-" });

      const snapshot = yield* checkKimiProviderStatus(
        decodeKimiSettings({ enabled: true, binaryPath: kimiPath }),
        kimiEnvironment(kimiHome),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.43.1");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("kimi login");
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-broken-" });
      const kimiPath = writeFakeCli({
        directory: dir,
        name: "kimi",
        source: ["process.stderr.write('broken kimi install');", "process.exit(2);", ""].join("\n"),
      });
      const snapshot = yield* checkKimiProviderStatus(
        decodeKimiSettings({ enabled: true, binaryPath: kimiPath }),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.message).toBe("Kimi Code CLI is installed but failed to run.");
    }),
  );

  it.effect("merges custom models after the built-ins", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(
        decodeKimiSettings({
          enabled: true,
          customModels: [{ slug: "kimi-code/custom-tuned", name: "Custom Tuned" }],
        }),
      );
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "kimi-code/kimi-for-coding",
        "kimi-code/kimi-for-coding-highspeed",
        "kimi-code/k3",
        "kimi-code/k3-256k",
        "kimi-code/custom-tuned",
      ]);
      expect(snapshot.models.at(-1)?.isCustom).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("makeKimiCommandCatalog", (it) => {
  const machineSnapshot: ServerProvider = {
    displayName: "Kimi Code",
    instanceId: ProviderInstanceId.make("kimi"),
    driver: ProviderDriverKind.make("kimi"),
    enabled: true,
    installed: true,
    version: "0.43.1",
    status: "ready",
    auth: { status: "authenticated", type: "cached_token", label: "Kimi account" },
    checkedAt: "2026-09-17T00:00:00.000Z",
    models: [],
    slashCommands: [{ name: "compact", description: "Compact the conversation" }],
    skills: [],
  };
  const baseShape: ServerProviderShape = {
    resolveMaintenance: () => Effect.die("not used in this test"),
    getSnapshot: Effect.succeed(machineSnapshot),
    refresh: Effect.succeed(machineSnapshot),
    streamChanges: Stream.empty,
    applyUsageLimits: () => Effect.void,
  };

  it.effect(
    "records advertised commands per workspace and falls back to the machine snapshot",
    () =>
      Effect.gen(function* () {
        const { onAvailableCommands, snapshotForCwd } = yield* makeKimiCommandCatalog(baseShape);

        yield* onAvailableCommands(
          [
            { name: "compact", description: "Compact the conversation" },
            { name: "status", description: "Show session status" },
            { name: "help", description: "Show help", input: { hint: "topic" } },
          ],
          "/workspace-a",
        );

        const workspace = yield* snapshotForCwd("/workspace-a");
        expect(workspace.slashCommands).toEqual([
          { name: "compact", description: "Compact the conversation" },
          { name: "status", description: "Show session status" },
          { name: "help", description: "Show help", input: { hint: "topic" } },
        ]);

        const untouched = yield* snapshotForCwd("/workspace-b");
        expect(untouched.slashCommands).toEqual([
          { name: "compact", description: "Compact the conversation" },
        ]);
      }),
  );
});
