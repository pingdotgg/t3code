import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/contracts";

import {
  buildInitialGrokProviderSnapshot,
  capabilitiesFromGrokModelMeta,
  checkGrokProviderStatus,
  ensureGrokStaticSlashCommands,
  GROK_STATIC_SLASH_COMMANDS,
  isGrokSessionModelState,
  mapAcpCommandsToCatalog,
} from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      expect(snapshot.showInteractionModeToggle).toBe(true);
      expect(snapshot.slashCommands).toEqual(GROK_STATIC_SLASH_COMMANDS);
    }),
  );
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken grok install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-version-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-success-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "grok-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );
});

describe("Grok capability and command helpers", () => {
  it("maps reasoningEfforts meta into optionDescriptors", () => {
    const caps = capabilitiesFromGrokModelMeta({
      reasoningEfforts: [
        { id: "high", value: "high", label: "High Effort", default: true },
        { id: "low", value: "low", label: "Low Effort", default: false },
      ],
    });
    expect(caps.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      type: "select",
    });
    expect(
      caps.optionDescriptors?.[0]?.type === "select" && caps.optionDescriptors[0].options,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "high", label: "High Effort", isDefault: true }),
        expect.objectContaining({ id: "low", label: "Low Effort" }),
      ]),
    );
  });

  it("maps ACP commands into slash and skills catalogs", () => {
    const catalog = mapAcpCommandsToCatalog([
      { name: "review", description: "Review code", inputHint: "path" },
      { name: "skip-me" },
    ]);
    expect(catalog.slashCommands).toHaveLength(2);
    expect(catalog.skills).toEqual([expect.objectContaining({ name: "review", enabled: true })]);
  });

  it("re-adds compact when live catalog omits it", () => {
    expect(ensureGrokStaticSlashCommands([])).toEqual(GROK_STATIC_SLASH_COMMANDS);
    expect(
      ensureGrokStaticSlashCommands([{ name: "review", description: "Review" }]).map(
        (command) => command.name,
      ),
    ).toEqual(["review", "compact"]);
    expect(
      ensureGrokStaticSlashCommands([
        { name: "compact", description: "Live compact" },
        { name: "review" },
      ]).map((command) => command.name),
    ).toEqual(["compact", "review"]);
  });

  it("rejects malformed modelState so discovery falls back instead of throwing", () => {
    expect(isGrokSessionModelState(null)).toBe(false);
    expect(isGrokSessionModelState(undefined)).toBe(false);
    expect(isGrokSessionModelState({ availableModels: [null] })).toBe(false);
    expect(
      isGrokSessionModelState({
        availableModels: [{ modelId: "grok-4", name: 123 }],
      }),
    ).toBe(false);
    expect(
      isGrokSessionModelState({
        availableModels: [{ name: "Grok" }],
      }),
    ).toBe(false);
    expect(
      isGrokSessionModelState({
        availableModels: [{ modelId: "grok-4", name: "Grok 4" }],
      }),
    ).toBe(true);
    expect(
      isGrokSessionModelState({
        currentModelId: "grok-4",
        availableModels: [{ modelId: "grok-4", name: "Grok 4" }],
      }),
    ).toBe(true);
  });
});
