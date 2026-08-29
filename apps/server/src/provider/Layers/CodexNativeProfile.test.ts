import * as NodeAssert from "node:assert/strict";

import { createModelSelection } from "@t3tools/shared/model";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, it as vitestIt } from "vite-plus/test";

import { codexAppServerArgs } from "./codexLaunchArgs.ts";
import {
  CODEX_GLM53_INSTANCE_ID,
  CODEX_GLM53_MAX_RESIDENT_THREADS,
  CODEX_GLM53_MAX_WORKERS,
  CODEX_GLM53_MODEL,
  CODEX_GLM53_MODEL_CATALOG_FILENAME,
  CODEX_GLM53_NATIVE_PROFILE,
  CODEX_GLM53_REASONING_EFFORTS,
  applyCodexNativeProfileModelCapabilities,
  codexNativeProfileCatalogPath,
  codexNativeProfileExpectedParent,
  codexNativeProfileHomeIssue,
  codexNativeProfileLaunchArgs,
  codexNativeProfileSelectionIssue,
} from "./CodexNativeProfile.ts";

describe("Codex GLM native profile", () => {
  const homePath = "/srv/codex/glm53";
  const catalogPath = `${homePath}/${CODEX_GLM53_MODEL_CATALOG_FILENAME}`;

  it.effect("configures root plus ten resident workers on multi-agent v2", () =>
    Effect.gen(function* () {
      const launchArgs = yield* codexNativeProfileLaunchArgs(
        CODEX_GLM53_NATIVE_PROFILE,
        "",
        homePath,
      );
      NodeAssert.equal(CODEX_GLM53_MAX_WORKERS, 10);
      NodeAssert.equal(CODEX_GLM53_MAX_RESIDENT_THREADS, 11);
      NodeAssert.deepStrictEqual(codexAppServerArgs(launchArgs), [
        "app-server",
        "--strict-config",
        "-c",
        'features.multi_agent_v2={ enabled = true, tool_namespace = "agents", max_concurrent_threads_per_session = 11, expose_spawn_agent_model_overrides = true }',
        "-c",
        'shell_environment_policy={ inherit = "core", ignore_default_excludes = false }',
        "-c",
        `model_catalog_json="${catalogPath}"`,
      ]);
    }),
  );

  it.effect(
    "keeps existing provider-scoped launch arguments while pinning native inheritance",
    () =>
      Effect.gen(function* () {
        const launchArgs = yield* codexNativeProfileLaunchArgs(
          CODEX_GLM53_NATIVE_PROFILE,
          '-c model_provider="openrouter"',
          homePath,
        );
        NodeAssert.deepStrictEqual(codexAppServerArgs(launchArgs), [
          "app-server",
          "-c",
          "model_provider=openrouter",
          "--strict-config",
          "-c",
          'features.multi_agent_v2={ enabled = true, tool_namespace = "agents", max_concurrent_threads_per_session = 11, expose_spawn_agent_model_overrides = true }',
          "-c",
          'shell_environment_policy={ inherit = "core", ignore_default_excludes = false }',
          "-c",
          `model_catalog_json="${catalogPath}"`,
        ]);
      }),
  );

  it.effect("derives and safely quotes the catalog path from a non-Victor home", () =>
    Effect.gen(function* () {
      const spacedHome = "/srv/T3 homes/glm'53";
      const launchArgs = yield* codexNativeProfileLaunchArgs(
        CODEX_GLM53_NATIVE_PROFILE,
        "",
        spacedHome,
      );
      NodeAssert.equal(
        codexNativeProfileCatalogPath(CODEX_GLM53_NATIVE_PROFILE, spacedHome),
        `/srv/T3 homes/glm'53/${CODEX_GLM53_MODEL_CATALOG_FILENAME}`,
      );
      NodeAssert.deepStrictEqual(codexAppServerArgs(launchArgs).slice(-2), [
        "-c",
        `model_catalog_json="/srv/T3 homes/glm'53/${CODEX_GLM53_MODEL_CATALOG_FILENAME}"`,
      ]);
    }),
  );

  it.effect("rejects missing, relative, root, and control-character homes", () =>
    Effect.gen(function* () {
      for (const unsafeHome of [undefined, "", "relative/home", "/", "/safe\nhome"]) {
        NodeAssert.ok(codexNativeProfileHomeIssue(CODEX_GLM53_NATIVE_PROFILE, unsafeHome));
        const result = yield* codexNativeProfileLaunchArgs(
          CODEX_GLM53_NATIVE_PROFILE,
          "",
          unsafeHome,
        ).pipe(Effect.result);
        NodeAssert.equal(result._tag, "Failure");
      }
    }),
  );

  vitestIt("accepts only High or Max and resolves the exact selected parent profile", () => {
    const exact = createModelSelection(CODEX_GLM53_INSTANCE_ID, CODEX_GLM53_MODEL, [
      { id: "reasoningEffort", value: "max" },
    ]);
    NodeAssert.equal(
      codexNativeProfileSelectionIssue(CODEX_GLM53_NATIVE_PROFILE, exact),
      undefined,
    );
    const high = createModelSelection(CODEX_GLM53_INSTANCE_ID, CODEX_GLM53_MODEL, [
      { id: "reasoningEffort", value: "high" },
    ]);
    NodeAssert.equal(codexNativeProfileSelectionIssue(CODEX_GLM53_NATIVE_PROFILE, high), undefined);
    NodeAssert.equal(
      codexNativeProfileExpectedParent(CODEX_GLM53_NATIVE_PROFILE, high).reasoningEffort,
      "high",
    );
    NodeAssert.deepStrictEqual(CODEX_GLM53_REASONING_EFFORTS, ["high", "max"]);
    NodeAssert.match(
      codexNativeProfileSelectionIssue(
        CODEX_GLM53_NATIVE_PROFILE,
        createModelSelection(CODEX_GLM53_INSTANCE_ID, CODEX_GLM53_MODEL, [
          { id: "reasoningEffort", value: "medium" },
        ]),
      ) ?? "",
      /requires reasoning effort 'high' or 'max'/,
    );
    NodeAssert.match(
      codexNativeProfileSelectionIssue(
        CODEX_GLM53_NATIVE_PROFILE,
        createModelSelection(CODEX_GLM53_INSTANCE_ID, "gpt-5.6-sol"),
      ) ?? "",
      /requires model 'z-ai\/glm-5\.3-flash'/,
    );
  });

  vitestIt("shows High and Max in the GLM picker with Max as the default", () => {
    const [model] = applyCodexNativeProfileModelCapabilities(CODEX_GLM53_INSTANCE_ID, [
      {
        slug: CODEX_GLM53_MODEL,
        name: CODEX_GLM53_MODEL,
        isCustom: true,
        capabilities: null,
      },
    ]);
    NodeAssert.deepStrictEqual(model?.capabilities?.optionDescriptors, [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "high", label: "High" },
          { id: "max", label: "Max", isDefault: true },
        ],
      },
    ]);
  });
});
