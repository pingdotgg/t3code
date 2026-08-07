import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HermesSettings } from "@t3tools/contracts";

import {
  buildInitialHermesProviderSnapshot,
  checkHermesProviderStatus,
  hermesDiscoveredModelsFromSessionModelState,
  hermesModelSlugFromAcpModelId,
} from "./HermesProvider.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

/** Writes a fake `hermes` CLI that answers --version itself and defers `acp`
 * to the shared ACP mock agent. */
const writeMockHermesWrapper = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-hermes-acp-models-" });
  const wrapperPath = path.join(dir, "hermes");
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf "hermes 0.8.0 (2026.4.8) [af4abd2f]\\n"
  exit 0
fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  yield* fs.writeFileString(wrapperPath, script);
  yield* fs.chmod(wrapperPath, 0o755);
  return wrapperPath;
});

describe("buildInitialHermesProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(
        decodeHermesSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot with the static model catalog by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(decodeHermesSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Hermes");
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-4.6",
        "anthropic/claude-haiku-4.5",
        "openai/gpt-5",
      ]);
    }),
  );

  it.effect("appends custom models on top of the static catalog", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(
        decodeHermesSettings({ customModels: ["openrouter:z-ai/glm-5.1"] }),
      );
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-4.6",
        "anthropic/claude-haiku-4.5",
        "openai/gpt-5",
        "openrouter:z-ai/glm-5.1",
      ]);
      const custom = snapshot.models.find((model) => model.slug === "openrouter:z-ai/glm-5.1");
      expect(custom?.isCustom).toBe(true);
    }),
  );
});

describe("hermesModelSlugFromAcpModelId", () => {
  it("converts provider:model ids to provider/model slugs", () => {
    expect(hermesModelSlugFromAcpModelId("openrouter:deepseek/deepseek-v4-flash-0731")).toBe(
      "openrouter/deepseek/deepseek-v4-flash-0731",
    );
    expect(hermesModelSlugFromAcpModelId("anthropic:claude-sonnet-4.6")).toBe(
      "anthropic/claude-sonnet-4.6",
    );
  });

  it("passes bare model ids through", () => {
    expect(hermesModelSlugFromAcpModelId("grok-build")).toBe("grok-build");
  });

  it("rejects empty and malformed ids", () => {
    expect(hermesModelSlugFromAcpModelId("  ")).toBeUndefined();
    expect(hermesModelSlugFromAcpModelId(":no-provider")).toBeUndefined();
    expect(hermesModelSlugFromAcpModelId("no-model:")).toBeUndefined();
  });
});

describe("hermesDiscoveredModelsFromSessionModelState", () => {
  it("maps available models to slugs and dedupes", () => {
    const models = hermesDiscoveredModelsFromSessionModelState({
      currentModelId: "openrouter:deepseek/deepseek-v4-flash-0731",
      availableModels: [
        {
          modelId: "openrouter:deepseek/deepseek-v4-flash-0731",
          name: "OpenRouter · deepseek/deepseek-v4-flash-0731",
        },
        {
          modelId: "openrouter:deepseek/deepseek-v4-flash-0731",
          name: "duplicate",
        },
        { modelId: "anthropic:claude-sonnet-4.6", name: "Anthropic · claude-sonnet-4.6" },
      ],
    });
    expect(models.map((model) => model.slug)).toEqual([
      "openrouter/deepseek/deepseek-v4-flash-0731",
      "anthropic/claude-sonnet-4.6",
    ]);
    expect(models[0]?.name).toBe("OpenRouter · deepseek/deepseek-v4-flash-0731");
    expect(models.every((model) => !model.isCustom)).toBe(true);
  });

  it("returns an empty list for missing model state", () => {
    expect(hermesDiscoveredModelsFromSessionModelState(undefined)).toEqual([]);
    expect(
      hermesDiscoveredModelsFromSessionModelState({
        currentModelId: "grok-build",
        availableModels: [],
      }),
    ).toEqual([]);
  });

  it("attaches a reasoning descriptor when the ACP server declares an effort option", () => {
    const models = hermesDiscoveredModelsFromSessionModelState(
      {
        currentModelId: "openrouter:deepseek/deepseek-v4-flash-0731",
        availableModels: [
          {
            modelId: "openrouter:deepseek/deepseek-v4-flash-0731",
            name: "DeepSeek V4 Flash",
          },
        ],
      },
      [
        {
          id: "effort",
          name: "Reasoning",
          category: "model_option",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
      ],
    );
    expect(models.map((model) => model.slug)).toEqual([
      "openrouter/deepseek/deepseek-v4-flash-0731",
    ]);
    const reasoning = models[0]?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "reasoning",
    );
    expect(reasoning?.type).toBe("select");
  });

  it("stays descriptor-less when no effort option is advertised", () => {
    const models = hermesDiscoveredModelsFromSessionModelState(
      {
        currentModelId: "grok-build",
        availableModels: [{ modelId: "grok-build", name: "Grok Build" }],
      },
      [],
    );
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([]);
  });
});

it.layer(NodeServices.layer)("checkHermesProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkHermesProviderStatus(
        decodeHermesSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/hermes-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-hermes-success-" });
          const hermesPath = path.join(dir, "hermes");
          yield* fs.writeFileString(
            hermesPath,
            ["#!/bin/sh", 'printf "hermes 0.8.0 (2026.4.8) [af4abd2f]\\n"', "exit 0", ""].join(
              "\n",
            ),
          );
          yield* fs.chmod(hermesPath, 0o755);

          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.8.0");
      expect(snapshot.message).toContain("ACP startup failed");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-4.6",
        "anthropic/claude-haiku-4.5",
        "openai/gpt-5",
      ]);
    }),
  );

  it.effect("uses discovered models from the ACP session model state", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeMockHermesWrapper;
          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.8.0");
      // The shared ACP mock agent advertises these via session/new.
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build", "grok-mock-alt"]);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-hermes-version-" });
          const hermesPath = path.join(dir, "hermes");
          yield* fs.writeFileString(
            hermesPath,
            ["#!/bin/sh", 'printf "%s\\n" "broken hermes install" >&2', "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(hermesPath, 0o755);

          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Hermes CLI is installed but failed to run.");
    }),
  );
});
