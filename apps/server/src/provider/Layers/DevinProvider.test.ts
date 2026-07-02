import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";
import { DevinSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  buildDevinDiscoveredModelsFromSessionSetup,
  checkDevinProviderStatus,
} from "./DevinProvider.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);

describe("buildDevinDiscoveredModelsFromSessionSetup", () => {
  it("builds Devin provider models from ACP model config options", () => {
    const models = buildDevinDiscoveredModelsFromSessionSetup({
      sessionId: "session-1",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "adaptive",
          options: [
            {
              group: "recommended",
              name: "Recommended",
              options: [
                { value: "adaptive", name: "Adaptive" },
                { value: "swe-1-6", name: "SWE-1.6" },
                { value: "swe-1-6-fast", name: "SWE-1.6 Fast" },
                { value: "MODEL_PRIVATE_11", name: "Private Model" },
              ],
            },
          ],
        },
      ],
      models: {
        currentModelId: "legacy-model-state",
        availableModels: [{ modelId: "legacy-model-state", name: "Legacy" }],
      },
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(
      models.map(({ slug, name, isCustom, capabilities }) => ({
        slug,
        name,
        isCustom,
        options: capabilities?.optionDescriptors?.map((descriptor) => descriptor.id) ?? [],
      })),
    ).toEqual([
      { slug: "adaptive", name: "Adaptive", isCustom: false, options: [] },
      { slug: "swe-1-6", name: "SWE-1.6", isCustom: false, options: ["fastMode"] },
      { slug: "private-model", name: "Private Model", isCustom: false, options: [] },
    ]);
  });

  it("collapses Devin thinking variants into provider option descriptors", () => {
    const models = buildDevinDiscoveredModelsFromSessionSetup({
      sessionId: "session-1",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-5-5-high-priority",
          options: [
            { value: "gpt-5-5-low", name: "GPT-5.5 Low Thinking" },
            { value: "gpt-5-5-medium", name: "GPT-5.5 Medium Thinking" },
            { value: "gpt-5-5-high-priority", name: "GPT-5.5 High Thinking Fast" },
            { value: "glm-5-2-high", name: "GLM-5.2 High" },
            { value: "glm-5-2-high-1m", name: "GLM-5.2 High 1M" },
          ],
        },
      ],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(models.map(({ slug, name }) => ({ slug, name }))).toEqual([
      { slug: "gpt-5-5", name: "GPT-5.5" },
      { slug: "glm-5-2", name: "GLM-5.2" },
    ]);

    const gpt = models.find((model) => model.slug === "gpt-5-5");
    expect(gpt?.capabilities?.optionDescriptors).toEqual([
      {
        id: "reasoning",
        label: "Thinking",
        type: "select",
        currentValue: "high",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
        currentValue: true,
      },
    ]);

    const glm = models.find((model) => model.slug === "glm-5-2");
    expect(glm?.capabilities?.optionDescriptors).toEqual([
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        currentValue: "default",
        options: [
          { id: "default", label: "Default", isDefault: true },
          { id: "1m", label: "1M" },
        ],
      },
    ]);
  });

  it("falls back to unstable ACP model state when no config selector is present", () => {
    const models = buildDevinDiscoveredModelsFromSessionSetup({
      sessionId: "session-1",
      models: {
        currentModelId: "adaptive",
        availableModels: [
          { modelId: " adaptive ", name: " Adaptive " },
          { modelId: "custom-devin-model", name: "Custom Devin Model" },
        ],
      },
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(models.map(({ slug, name, isCustom }) => ({ slug, name, isCustom }))).toEqual([
      { slug: "adaptive", name: "Adaptive", isCustom: false },
      { slug: "custom-devin-model", name: "Custom Devin Model", isCustom: false },
    ]);
  });
});

it.layer(NodeServices.layer)("checkDevinProviderStatus", (it) => {
  it.effect("reports ready without ACP model discovery when `devin version` succeeds", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const hostPlatform = yield* HostProcessPlatform;
          const isWin32 = hostPlatform === "win32";
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-version-" });
          const devinPath = path.join(dir, isWin32 ? "devin.cmd" : "devin");
          yield* fs.writeFileString(
            devinPath,
            isWin32
              ? [
                  "@echo off",
                  'if "%~1"=="version" (',
                  "  echo devin 1.2.3",
                  "  exit /b 0",
                  ")",
                  "echo unexpected Devin ACP invocation: %* 1>&2",
                  "exit /b 7",
                  "",
                ].join("\r\n")
              : [
                  "#!/bin/sh",
                  'if [ "$1" = "version" ]; then',
                  '  printf "devin 1.2.3\\n"',
                  "  exit 0",
                  "fi",
                  'printf "unexpected Devin ACP invocation: %s\\n" "$*" >&2',
                  "exit 7",
                  "",
                ].join("\n"),
          );
          yield* fs.chmod(devinPath, 0o755);

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "adaptive",
        "swe",
        "opus",
        "sonnet",
        "codex",
        "gemini",
      ]);
      expect(snapshot.message).toBeUndefined();
    }),
  );

  it.effect("uses cached real-session model discovery without probing ACP", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const hostPlatform = yield* HostProcessPlatform;
          const isWin32 = hostPlatform === "win32";
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-cached-" });
          const devinPath = path.join(dir, isWin32 ? "devin.cmd" : "devin");
          yield* fs.writeFileString(
            devinPath,
            isWin32
              ? [
                  "@echo off",
                  'if "%~1"=="version" (',
                  "  echo devin 1.2.3",
                  "  exit /b 0",
                  ")",
                  "echo unexpected Devin ACP invocation: %* 1>&2",
                  "exit /b 7",
                  "",
                ].join("\r\n")
              : [
                  "#!/bin/sh",
                  'if [ "$1" = "version" ]; then',
                  '  printf "devin 1.2.3\\n"',
                  "  exit 0",
                  "fi",
                  'printf "unexpected Devin ACP invocation: %s\\n" "$*" >&2',
                  "exit 7",
                  "",
                ].join("\n"),
          );
          yield* fs.chmod(devinPath, 0o755);

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            process.env,
            {
              cachedDiscoveredModels: [
                {
                  slug: "adaptive",
                  name: "Adaptive",
                  isCustom: false,
                  capabilities: null,
                },
                {
                  slug: "gpt-5-5",
                  name: "GPT-5.5",
                  isCustom: false,
                  capabilities: null,
                },
              ],
            },
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["adaptive", "gpt-5-5"]);
    }),
  );
});
