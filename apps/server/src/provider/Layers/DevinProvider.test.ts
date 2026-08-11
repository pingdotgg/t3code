import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DevinSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  buildInitialDevinProviderSnapshot,
  checkDevinProviderStatus,
  parseDevinModelsList,
} from "./DevinProvider.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);

function isWindows(platform: string) {
  return platform === "win32";
}

function makeMockDevinScript(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dir: string,
  content: string,
  platform: string,
) {
  const devinPath = isWindows(platform) ? path.join(dir, "devin.cmd") : path.join(dir, "devin");
  return Effect.gen(function* () {
    yield* fs.writeFileString(devinPath, content);
    if (!isWindows(platform)) {
      yield* fs.chmod(devinPath, 0o755);
    }
    return devinPath;
  });
}

function mockVersionScript(platform: string, secretStderr: string, exitCode: number) {
  if (isWindows(platform)) {
    return `@echo off\necho ${secretStderr} >&2\nexit /b ${exitCode}\n`;
  }
  return ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, `exit ${exitCode}`, ""].join("\n");
}

function mockModelsListScript(platform: string) {
  if (isWindows(platform)) {
    return [
      "@echo off",
      'if "%1" == "models" if "%2" == "list" if "%3" == "--format" if "%4" == "json" (',
      '  echo [{"family_label": "Adaptive", "slug": "adaptive"}]',
      "  exit /b 0",
      ")",
      "echo devin-cli 0.0.99",
      "exit /b 0",
      "",
    ].join("\n");
  }
  return [
    "#!/bin/sh",
    'if [ "$1" = "models" ] && [ "$2" = "list" ] && [ "$3" = "--format" ] && [ "$4" = "json" ]; then',
    '  printf "[{\\\"family_label\\\": \\\"Adaptive\\\", \\\"slug\\\": \\\"adaptive\\\"}]\\n"',
    "  exit 0",
    "fi",
    'printf "devin-cli 0.0.99\\n"',
    "exit 0",
    "",
  ].join("\n");
}

describe("buildInitialDevinProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(
        decodeDevinSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(decodeDevinSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Devin");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkDevinProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(
        decodeDevinSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/devin-binary",
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
      const platform = yield* HostProcessPlatform;
      const secretStderr = "broken devin install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({
            prefix: "t3code-devin-version-",
          });
          const devinPath = yield* makeMockDevinScript(
            fs,
            path,
            dir,
            mockVersionScript(platform, secretStderr, 2),
            platform,
          );

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Devin CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("discovers models via `devin models list` and reports ready", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({
            prefix: "t3code-devin-models-",
          });
          const devinPath = yield* makeMockDevinScript(
            fs,
            path,
            dir,
            mockModelsListScript(platform),
            platform,
          );

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["adaptive"]);
    }),
  );

  it.effect("falls back to built-in models when `devin models list` fails", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({
            prefix: "t3code-devin-fail-",
          });
          const devinPath = yield* makeMockDevinScript(
            fs,
            path,
            dir,
            mockVersionScript(platform, "", 0),
            platform,
          );

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["adaptive"]);
    }),
  );
});

it.layer(NodeServices.layer)("parseDevinModelsList", (it) => {
  it("parses model families from `devin models list` headers, skipping reasoning variants", () => {
    const output = [
      "Claude Opus 4.7 (claude-opus-4.7)",
      "  claude-opus-4-7-medium               Claude Opus 4.7 Medium  [1M context, $5 / MTok]",
      "  claude-opus-4-7-high                 Claude Opus 4.7 High  [1M context, $5 / MTok]",
      "",
      "Claude Opus 4.8 (claude-opus-4.8)",
      "  claude-opus-4-8-low                  Claude Opus 4.8 Low  [1M context, $5 / MTok]",
      "  claude-opus-4-8-high                 Claude Opus 4.8 High  [1M context, $5 / MTok]",
      "",
      "Adaptive (adaptive)",
      "  aliases: swe, opencode",
      "  adaptive                             Adaptive  [$0.5 / MTok]",
    ].join("\n");

    const models = parseDevinModelsList(output);
    expect(
      models.map((m) => ({
        slug: m.slug,
        name: m.name,
      })),
    ).toEqual([
      { slug: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { slug: "claude-opus-4-8", name: "Claude Opus 4.8" },
      { slug: "adaptive", name: "Adaptive" },
    ]);
  });

  it("returns an empty array when output has no models", () => {
    expect(parseDevinModelsList("No models available.")).toEqual([]);
  });

  it("deduplicates family slugs after normalization", () => {
    const output = ["Claude Opus 4.7 (claude-opus-4.7)", "Claude Opus 4.7 (claude-opus-4-7)"].join(
      "\n",
    );

    const models = parseDevinModelsList(output);
    expect(models).toHaveLength(1);
    expect(models[0]?.slug).toBe("claude-opus-4-7");
  });

  it("parses JSON output, returning one model per family", () => {
    const output = JSON.stringify({
      families: [
        {
          family_label: "Claude Opus 4.7",
          family_uid: "claude-opus-4.7",
          slug: "claude-opus-4.7",
          variants: [{ model_uid: "claude-opus-4-7-medium" }],
        },
        {
          family_label: "Claude Opus 4.8",
          family_uid: "claude-opus-4.8",
          slug: "claude-opus-4.8",
          variants: [{ model_uid: "claude-opus-4-8-low" }],
        },
        {
          family_label: "Adaptive",
          family_uid: "adaptive",
          slug: "adaptive",
          aliases: ["swe", "opencode"],
          variants: [{ model_uid: "adaptive" }],
        },
      ],
    });

    const models = parseDevinModelsList(output);
    expect(
      models.map((m) => ({
        slug: m.slug,
        name: m.name,
      })),
    ).toEqual([
      { slug: "adaptive", name: "Adaptive" },
      { slug: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { slug: "claude-opus-4-8", name: "Claude Opus 4.8" },
    ]);
  });

  it("still accepts a plain JSON array as fallback", () => {
    const output = JSON.stringify([
      {
        family_label: "Adaptive",
        family_uid: "adaptive",
        slug: "adaptive",
        variants: [{ model_uid: "adaptive" }],
      },
    ]);

    const models = parseDevinModelsList(output);
    expect(models.map((m) => m.slug)).toEqual(["adaptive"]);
  });

  it("groups flat JSON variants into one model per family", () => {
    const output = JSON.stringify([
      { model_uid: "claude-opus-5-medium", label: "Claude Opus 5 Medium" },
      { model_uid: "claude-opus-5-low", label: "Claude Opus 5 Low" },
      { model_uid: "claude-opus-5-high", label: "Claude Opus 5 High" },
      { model_uid: "claude-opus-5-xhigh", label: "Claude Opus 5 XHigh" },
      { model_uid: "claude-opus-5-max", label: "Claude Opus 5 Max" },
      { model_uid: "claude-opus-5-low-fast", label: "Claude Opus 5 Low Fast" },
      { model_uid: "gpt-5-6-sol-none", label: "GPT-5.6 Sol No Thinking" },
      { model_uid: "gpt-5-6-sol-low", label: "GPT-5.6 Sol Low Thinking" },
      { model_uid: "gpt-5-6-sol-high", label: "GPT-5.6 Sol High Thinking" },
      { model_uid: "adaptive", label: "Adaptive" },
    ]);

    const models = parseDevinModelsList(output);
    expect(
      models.map((m) => ({
        slug: m.slug,
        name: m.name,
      })),
    ).toEqual([
      { slug: "adaptive", name: "Adaptive" },
      { slug: "claude-opus-5", name: "Claude Opus 5" },
      { slug: "gpt-5-6-sol", name: "GPT-5.6 Sol" },
    ]);
  });

  it("uses family_uid when present in flat JSON variants", () => {
    const output = JSON.stringify([
      {
        model_uid: "claude-opus-5-medium",
        label: "Claude Opus 5 Medium",
        family_uid: "claude-opus-5",
        family_label: "Claude Opus 5",
      },
      {
        model_uid: "claude-opus-5-low",
        label: "Claude Opus 5 Low",
        family_uid: "claude-opus-5",
        family_label: "Claude Opus 5",
      },
    ]);

    const models = parseDevinModelsList(output);
    expect(models).toHaveLength(1);
    expect(models[0]?.slug).toBe("claude-opus-5");
    expect(models[0]?.name).toBe("Claude Opus 5");
  });

  it("groups flat JSON variants with compound family slugs", () => {
    const output = JSON.stringify([
      {
        model_uid: "swe-1-7-lightning-medium",
        label: "SWE-1.7 Lightning Medium",
      },
      { model_uid: "swe-1-7-lightning-max", label: "SWE-1.7 Lightning Max" },
      { model_uid: "glm-5-2-none", label: "GLM-5.2 No Thinking" },
      { model_uid: "glm-5-2-none-1m", label: "GLM-5.2 No Thinking 1M" },
      { model_uid: "glm-5-2-max", label: "GLM-5.2 Max" },
    ]);

    const models = parseDevinModelsList(output);
    expect(
      models.map((m) => ({
        slug: m.slug,
        name: m.name,
      })),
    ).toEqual([
      { slug: "glm-5-2", name: "GLM-5.2" },
      { slug: "swe-1-7-lightning", name: "SWE-1.7 Lightning" },
    ]);
  });

  it("derives the family slug from the label for opaque legacy model ids", () => {
    const output = JSON.stringify([
      { model_uid: "MODEL_PRIVATE_11", label: "Claude Haiku 4.5" },
      { model_uid: "MODEL_PRIVATE_2", label: "Claude Sonnet 4.5" },
      { model_uid: "MODEL_PRIVATE_3", label: "Claude Sonnet 4.5 Thinking" },
      { model_uid: "MODEL_GPT_5_2_LOW", label: "GPT-5.2 Low Thinking" },
      { model_uid: "MODEL_GPT_5_2_MEDIUM", label: "GPT-5.2 Medium Thinking" },
      { model_uid: "MODEL_CHAT_GPT_4_1_2025_04_14", label: "GPT-4.1" },
      {
        model_uid: "MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL",
        label: "Gemini 3 Flash Minimal",
      },
      {
        model_uid: "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
        label: "Gemini 3 Flash High",
      },
      { model_uid: "claude-5-fable-medium", label: "Claude Fable 5 Medium" },
      { model_uid: "claude-5-fable-low", label: "Claude Fable 5 Low" },
    ]);

    const models = parseDevinModelsList(output);
    expect(
      models.map((m) => ({
        slug: m.slug,
        name: m.name,
      })),
    ).toEqual([
      { slug: "claude-fable-5", name: "Claude Fable 5" },
      { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
      { slug: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { slug: "gemini-3-flash", name: "Gemini 3 Flash" },
      { slug: "gpt-4-1", name: "GPT-4.1" },
      { slug: "gpt-5-2", name: "GPT-5.2" },
    ]);
  });

  it("sorts discovered models by name", () => {
    const output = JSON.stringify([
      { model_uid: "claude-opus-5-medium", label: "Claude Opus 5 Medium" },
      { model_uid: "adaptive", label: "Adaptive" },
      { model_uid: "gpt-5-6-sol-low", label: "GPT-5.6 Sol Low Thinking" },
    ]);

    const models = parseDevinModelsList(output);
    expect(models.map((m) => m.name)).toEqual(["Adaptive", "Claude Opus 5", "GPT-5.6 Sol"]);
  });

  it.effect("parses the real exported devin model list into families with reasoning options", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = process.cwd();
      const raw = yield* fs.readFileString(path.join(cwd, "devin-models-list.txt"));
      const models = parseDevinModelsList(raw);

      expect(models.length).toBeLessThan(50);
      const opus5 = models.find((m) => m.slug === "claude-opus-5");
      expect(opus5).toBeDefined();
      const reasoning = opus5?.capabilities?.optionDescriptors?.[0];
      expect(reasoning?.id).toBe("reasoning");
      expect(reasoning?.type).toBe("select");
      if (reasoning?.type === "select") {
        expect(reasoning.options.some((o) => o.id === "medium")).toBe(true);
        expect(reasoning.options.some((o) => o.id === "low-fast")).toBe(true);
      }
    }),
  );

  it("exposes a reasoning option descriptor with real model_uids", () => {
    const output = JSON.stringify({
      families: [
        {
          family_label: "Claude Opus 5",
          family_uid: "claude-opus-5",
          slug: "claude-opus-5",
          variants: [
            {
              model_uid: "claude-opus-5-medium",
              label: "Claude Opus 5 Medium",
            },
            { model_uid: "claude-opus-5-low", label: "Claude Opus 5 Low" },
            { model_uid: "claude-opus-5-high", label: "Claude Opus 5 High" },
          ],
        },
        {
          family_label: "Adaptive",
          family_uid: "adaptive",
          slug: "adaptive",
          variants: [{ model_uid: "adaptive", label: "Adaptive" }],
        },
      ],
    });

    const models = parseDevinModelsList(output);
    const claudeOpus = models.find((m) => m.slug === "claude-opus-5");
    const adaptive = models.find((m) => m.slug === "adaptive");

    expect(claudeOpus?.capabilities?.optionDescriptors).toHaveLength(1);
    const reasoning = claudeOpus?.capabilities?.optionDescriptors?.[0];
    expect(reasoning?.id).toBe("reasoning");
    expect(reasoning?.type).toBe("select");
    expect(
      reasoning && reasoning.type === "select"
        ? reasoning.options.map((o) => ({ id: o.id, label: o.label }))
        : [],
    ).toEqual([
      { id: "medium", label: "Medium" },
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ]);

    expect(adaptive?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("uses the API variant labels for reasoning options", () => {
    const output = JSON.stringify({
      families: [
        {
          family_label: "SWE-1.7",
          family_uid: "swe-1.7",
          slug: "swe-1.7",
          variants: [
            { model_uid: "swe-1-7", label: "SWE-1.7 Max" },
            { model_uid: "swe-1-7-medium", label: "SWE-1.7 Medium" },
          ],
        },
        {
          family_label: "SWE-1.7 Lightning",
          family_uid: "swe-1.7-lightning",
          slug: "swe-1.7-lightning",
          variants: [
            { model_uid: "swe-1-7-lightning", label: "SWE-1.7 Lightning Max" },
            {
              model_uid: "swe-1-7-lightning-medium",
              label: "SWE-1.7 Lightning Medium",
            },
          ],
        },
        {
          family_label: "GLM-5.2",
          family_uid: "glm-5.2",
          slug: "glm-5.2",
          variants: [
            { model_uid: "glm-5-2", label: "GLM-5.2 High" },
            { model_uid: "glm-5-2-max", label: "GLM-5.2 Max" },
            { model_uid: "glm-5-2-none", label: "GLM-5.2 No Thinking" },
            { model_uid: "glm-5-2-none-1m", label: "GLM-5.2 No Thinking 1M" },
          ],
        },
      ],
    });

    const models = parseDevinModelsList(output);
    const swe = models.find((m) => m.slug === "swe-1-7");
    const sweLightning = models.find((m) => m.slug === "swe-1-7-lightning");
    const glm = models.find((m) => m.slug === "glm-5-2");

    const reasoningOptions = (model: (typeof models)[number]) =>
      model?.capabilities?.optionDescriptors?.[0]?.type === "select"
        ? model.capabilities.optionDescriptors[0].options.map((o) => ({
            id: o.id,
            label: o.label,
          }))
        : [];

    expect(swe).toBeDefined();
    expect(sweLightning).toBeDefined();
    expect(glm).toBeDefined();
    expect(reasoningOptions(swe!)).toEqual([
      { id: "max", label: "Max" },
      { id: "medium", label: "Medium" },
    ]);
    expect(reasoningOptions(sweLightning!)).toEqual([
      { id: "max", label: "Max" },
      { id: "medium", label: "Medium" },
    ]);
    expect(reasoningOptions(glm!)).toEqual([
      { id: "high", label: "High" },
      { id: "max", label: "Max" },
      { id: "no-thinking", label: "No Thinking" },
      { id: "no-thinking-1m", label: "No Thinking 1M" },
    ]);
  });
});
