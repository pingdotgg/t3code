// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HermesSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildHermesCapabilitiesFromConfigOptions,
  buildHermesDiscoveredModels,
  checkHermesProviderStatus,
  discoverHermesModelsFromAcpSession,
  makePendingHermesProvider,
} from "./HermesProvider.ts";

const decodeSettings = Schema.decodeSync(HermesSettings);

describe("HermesProvider", () => {
  it.effect("builds a CLI-oriented pending snapshot with in-session model changes", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingHermesProvider(
        decodeSettings({ enabled: true, binaryPath: "hermes" }),
      );
      expect(snapshot.message).toContain("Hermes CLI");
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      expect(snapshot.models[0]?.slug).toBe("hermes-default");
    }),
  );

  it("preserves provider-qualified future model ids and exact advertised option metadata", () => {
    const qualifiedModelId = "custom:vNext/model@2027";
    const configOptions = [
      {
        id: "reasoning/vNext",
        name: "Reasoning Effort vNext",
        description: "Provider-defined reasoning control",
        type: "select" as const,
        currentValue: "future/max",
        options: [
          { value: "provider:auto", name: "Provider Auto" },
          {
            value: "future/max",
            name: "Future Max",
            description: "A provider-defined future value",
          },
        ],
      },
      {
        id: "extended_context",
        name: "Extended context",
        type: "boolean" as const,
        currentValue: true,
      },
    ];
    const models = buildHermesDiscoveredModels(
      {
        currentModelId: qualifiedModelId,
        availableModels: [
          {
            modelId: qualifiedModelId,
            name: "Future Model 2027",
          },
          {
            modelId: "openrouter:moonshotai/kimi-k2.5",
            name: "Kimi K2.5",
          },
        ],
      },
      new Map([[qualifiedModelId, configOptions]]),
    );
    expect(models.map((model) => model.slug)).toEqual([
      qualifiedModelId,
      "openrouter:moonshotai/kimi-k2.5",
    ]);
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([
      {
        id: "reasoning/vNext",
        label: "Reasoning Effort vNext",
        description: "Provider-defined reasoning control",
        type: "select",
        currentValue: "future/max",
        options: [
          { id: "provider:auto", label: "Provider Auto" },
          {
            id: "future/max",
            label: "Future Max",
            description: "A provider-defined future value",
            isDefault: true,
          },
        ],
      },
      {
        id: "extended_context",
        label: "Extended context",
        type: "boolean",
        currentValue: true,
      },
    ]);
    expect(models[1]?.capabilities?.optionDescriptors).toEqual([]);
    expect(buildHermesCapabilitiesFromConfigOptions(configOptions)).toEqual(
      models[0]?.capabilities,
    );
  });

  it.effect("discovers capabilities from each model's refreshed catalog without cloning", () =>
    Effect.gen(function* () {
      const currentModelId = "anthropic:claude-sonnet-5";
      let activeModelId = currentModelId;
      const calls: string[] = [];
      const catalogs = new Map<string, ReadonlyArray<EffectAcpSchema.SessionConfigOption>>([
        [
          "openrouter:reasoning/model-vNext",
          [
            {
              id: "reasoning_effort",
              name: "Reasoning effort",
              type: "select",
              currentValue: "ultra",
              options: [
                { value: "medium", name: "Medium" },
                { value: "ultra", name: "Ultra" },
              ],
            },
          ],
        ],
        ["custom:no-reasoning-yet", []],
      ]);

      const models = yield* discoverHermesModelsFromAcpSession({
        runtime: {
          setSessionModel: (modelId) =>
            Effect.sync(() => {
              calls.push(`model:${modelId}`);
              activeModelId = modelId;
              return {};
            }),
          getConfigOptions: Effect.sync(() => {
            calls.push(`catalog:${activeModelId}`);
            return catalogs.get(activeModelId) ?? [];
          }),
        },
        sessionSetupResult: {
          sessionId: "probe-session",
          models: {
            currentModelId,
            availableModels: [
              { modelId: currentModelId, name: "Claude Sonnet 5" },
              {
                modelId: "openrouter:reasoning/model-vNext",
                name: "Reasoning Model vNext",
              },
              { modelId: "custom:no-reasoning-yet", name: "No Reasoning Yet" },
            ],
          },
          configOptions: [],
        },
      });

      expect(calls).toEqual([
        "model:openrouter:reasoning/model-vNext",
        "catalog:openrouter:reasoning/model-vNext",
        "model:custom:no-reasoning-yet",
        "catalog:custom:no-reasoning-yet",
      ]);
      expect(
        models.map((model) => [model.slug, model.capabilities?.optionDescriptors?.length]),
      ).toEqual([
        [currentModelId, 0],
        ["openrouter:reasoning/model-vNext", 1],
        ["custom:no-reasoning-yet", 0],
      ]);
    }),
  );
});

it.layer(NodeServices.layer)("checkHermesProviderStatus", (it) => {
  it.effect("reports a missing Hermes CLI", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkHermesProviderStatus(
        decodeSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/hermes",
        }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("keeps only the capability-free fallback when ACP discovery fails", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-discovery-fail-"));
    const binaryPath = NodePath.join(tempDir, "hermes");
    NodeFS.writeFileSync(
      binaryPath,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Hermes 9.9.9"; exit 0; fi\nexit 23\n',
      { encoding: "utf8", mode: 0o755 },
    );
    return Effect.gen(function* () {
      const snapshot = yield* checkHermesProviderStatus(
        decodeSettings({
          enabled: true,
          binaryPath,
        }),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.models).toEqual([
        {
          slug: "hermes-default",
          name: "Hermes default",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
      ]);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });
});
