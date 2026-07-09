// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GrokSettings, type ModelCapabilities } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildGrokDiscoveredModelsFromSessionModelState,
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
} from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function grok45ReasoningDescriptor(snapshot: {
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly capabilities: ModelCapabilities | null;
  }>;
}) {
  const grok45 = snapshot.models.find((model) => model.slug === "grok-4.5");
  return grok45?.capabilities?.optionDescriptors?.find(
    (descriptor) => descriptor.id === "reasoningEffort" && descriptor.type === "select",
  );
}

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
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
    }),
  );

  it.effect("includes Grok 4.5 with reasoning effort choices", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));

      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-4.5", "grok-build"]);
      const descriptor = grok45ReasoningDescriptor(snapshot);
      expect(descriptor).toMatchObject({
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "high",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
        ],
      });
    }),
  );

  it("maps ACP _meta reasoning efforts and defensively falls back for invalid metadata", () => {
    const models = buildGrokDiscoveredModelsFromSessionModelState({
      currentModelId: "grok-4.5",
      availableModels: [
        {
          modelId: "grok-live-meta",
          name: "Grok Live Meta",
          _meta: {
            supportsReasoningEffort: true,
            reasoningEffort: "low",
            reasoningEfforts: [
              { id: "high", value: "high", label: "High Effort", default: true },
              { id: "medium", value: "medium", label: "Medium Effort", default: false },
              { id: "low", value: "low", label: "Low Effort", default: false },
            ],
          },
        },
        {
          modelId: "grok-4.5",
          name: "Grok 4.5",
          _meta: {
            supportsReasoningEffort: true,
            reasoningEffort: "low",
            reasoningEfforts: "not-an-array",
          },
        },
        {
          modelId: "grok-missing-current-effort",
          name: "Grok Missing Current Effort",
          _meta: {
            supportsReasoningEffort: true,
            reasoningEffort: "medium",
            reasoningEfforts: [
              { id: "high", value: "high", label: "High Effort", default: true },
              { id: "low", value: "low", label: "Low Effort", default: false },
            ],
          },
        },
        {
          modelId: "grok-invalid-meta",
          name: "Grok Invalid Meta",
          _meta: {
            supportsReasoningEffort: true,
            reasoningEfforts: [{ id: "", label: "Blank" }],
          },
        },
      ],
    } as EffectAcpSchema.SessionModelState);

    const missingCurrentDescriptor = models
      .find((model) => model.slug === "grok-missing-current-effort")
      ?.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "reasoningEffort" && descriptor.type === "select",
      );
    expect(missingCurrentDescriptor).toMatchObject({
      options: [
        { id: "high", label: "High", isDefault: true },
        { id: "low", label: "Low" },
      ],
    });
    expect(missingCurrentDescriptor).not.toHaveProperty("currentValue");

    const liveDescriptor = models
      .find((model) => model.slug === "grok-live-meta")
      ?.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "reasoningEffort" && descriptor.type === "select",
      );
    expect(liveDescriptor).toMatchObject({
      currentValue: "low",
      options: [
        { id: "high", label: "High", isDefault: true },
        { id: "medium", label: "Medium" },
        { id: "low", label: "Low" },
      ],
    });

    expect(
      models
        .find((model) => model.slug === "grok-4.5")
        ?.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.id === "reasoningEffort" && descriptor.type === "select",
        ),
    ).toMatchObject({ currentValue: "high" });
    expect(
      models.find((model) => model.slug === "grok-invalid-meta")?.capabilities?.optionDescriptors,
    ).toEqual([]);
  });
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
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-4.5", "grok-build"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );

  it.effect("uses discovered Grok models as authoritative and maps xAI reasoning metadata", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-acp-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then',
              '  printf "grok-cli 0.2.91\\n"',
              "  exit 0",
              "fi",
              'if [ "$1" != "agent" ] || [ "$2" != "stdio" ]; then',
              '  printf "%s\\n" "unexpected args: $*" >&2',
              "  exit 11",
              "fi",
              `exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(mockAgentPath)}`,
              "",
            ].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "grok-4.5",
        "grok-composer-2.5-fast",
        "grok-mock-alt",
      ]);
      expect(snapshot.models.some((model) => model.slug === "grok-build")).toBe(false);
      expect(snapshot.models.filter((model) => model.slug === "grok-4.5")).toHaveLength(1);
      expect(grok45ReasoningDescriptor(snapshot)).toMatchObject({
        currentValue: "high",
        options: [
          { id: "high", label: "High", isDefault: true },
          { id: "medium", label: "Medium" },
          { id: "low", label: "Low" },
        ],
      });
    }),
  );
});
