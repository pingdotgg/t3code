import type { SDKModel } from "@cursor/sdk";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CursorSettings } from "@t3tools/contracts";
import { CursorSettings as CursorSettingsSchema } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildCursorCapabilitiesFromSdkModel,
  buildCursorDiscoveredModelsFromSdk,
  buildCursorProviderSnapshot,
  buildInitialCursorProviderSnapshot,
  checkCursorProviderStatus,
  getCursorFallbackModels,
} from "./CursorProvider.ts";
import { CursorSdkCatalogError, makeCursorSdkCatalogTestLayer } from "./CursorSdkCatalog.ts";

const decodeCursorSettings = Schema.decodeSync(CursorSettingsSchema);

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string, currentValue?: boolean) {
  return {
    id,
    label,
    type: "boolean" as const,
    ...(typeof currentValue === "boolean" ? { currentValue } : {}),
  };
}

const baseCursorSettings: CursorSettings = decodeCursorSettings({
  enabled: true,
  customModels: [],
});

const sdkParameterizedModel = {
  id: "claude-opus-4-8",
  displayName: "Opus 4.8",
  parameters: [
    {
      id: "thinking",
      displayName: "Thinking",
      values: [{ value: "false" }, { value: "true" }],
    },
    {
      id: "context",
      displayName: "Context",
      values: [
        { value: "300k", displayName: "300K" },
        { value: "1m", displayName: "1M" },
      ],
    },
    {
      id: "effort",
      displayName: "Effort",
      values: [
        { value: "low", displayName: "Low" },
        { value: "high", displayName: "High" },
      ],
    },
    {
      id: "fast",
      displayName: "Fast",
      values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
    },
  ],
  variants: [
    {
      displayName: "Opus 4.8",
      isDefault: true,
      params: [
        { id: "thinking", value: "true" },
        { id: "context", value: "1m" },
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    },
  ],
} satisfies SDKModel;

describe("getCursorFallbackModels", () => {
  it("does not publish any built-in cursor models before SDK discovery", () => {
    expect(
      getCursorFallbackModels({
        customModels: ["internal/cursor-model"],
      }).map((model) => model.slug),
    ).toEqual(["internal/cursor-model"]);
  });
});

describe("buildInitialCursorProviderSnapshot", () => {
  it.effect("uses SDK-specific pending status copy", () =>
    Effect.gen(function* () {
      const provider = yield* buildInitialCursorProviderSnapshot(baseCursorSettings);

      expect(provider).toMatchObject({
        status: "warning",
        message: "Checking Cursor SDK availability...",
      });
    }),
  );
});

describe("buildCursorProviderSnapshot", () => {
  it("downgrades ready status to warning when SDK model discovery returns no models", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: baseCursorSettings,
        parsed: {
          version: null,
          status: "ready",
          auth: { status: "authenticated", type: "api-key", label: "Cursor API key" },
        },
        discoveryWarning: "Cursor SDK model discovery returned no built-in models.",
      }),
    ).toMatchObject({
      status: "warning",
      message: "Cursor SDK model discovery returned no built-in models.",
      models: [],
    });
  });
});

describe("Cursor SDK model discovery", () => {
  it("maps native SDK parameter ids and default variant values to model capabilities", () => {
    expect(buildCursorCapabilitiesFromSdkModel(sdkParameterizedModel)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("effort", "Effort", [
            { id: "low", label: "Low" },
            { id: "high", label: "High", isDefault: true },
          ]),
          selectDescriptor("contextWindow", "Context", [
            { id: "300k", label: "300K" },
            { id: "1m", label: "1M", isDefault: true },
          ]),
          booleanDescriptor("fastMode", "Fast", false),
          booleanDescriptor("thinking", "Thinking", true),
        ],
      }),
    );
  });

  it("filters invalid and duplicate SDK model entries", () => {
    expect(
      buildCursorDiscoveredModelsFromSdk([
        sdkParameterizedModel,
        { ...sdkParameterizedModel, displayName: "Duplicate" },
        { id: "", displayName: "Invalid" },
      ]),
    ).toEqual([
      {
        slug: "claude-opus-4-8",
        name: "Opus 4.8",
        isCustom: false,
        capabilities: buildCursorCapabilitiesFromSdkModel(sdkParameterizedModel),
      },
    ]);
  });
});

describe("checkCursorProviderStatus", () => {
  it("uses the SDK catalog when CURSOR_API_KEY is configured", async () => {
    const provider = await Effect.runPromise(
      checkCursorProviderStatus(
        {
          ...baseCursorSettings,
          customModels: ["internal/cursor-model"],
        },
        { CURSOR_API_KEY: "test-cursor-key" },
      ).pipe(
        Effect.provide(
          makeCursorSdkCatalogTestLayer((apiKey) => {
            expect(apiKey).toBe("test-cursor-key");
            return Effect.succeed({
              user: {
                apiKeyName: "test-key",
                userEmail: "cursor@example.com",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
              models: [sdkParameterizedModel],
            });
          }),
        ),
      ),
    );

    expect(provider).toMatchObject({
      status: "ready",
      auth: {
        status: "authenticated",
        type: "api-key",
        label: "Cursor API key (test-key)",
        email: "cursor@example.com",
      },
      models: [
        { slug: "claude-opus-4-8", isCustom: false },
        { slug: "internal/cursor-model", isCustom: true },
      ],
    });
  });

  it("surfaces SDK authentication failures", async () => {
    const provider = await Effect.runPromise(
      checkCursorProviderStatus(baseCursorSettings, {
        CURSOR_API_KEY: "invalid-test-key",
      }).pipe(
        Effect.provide(
          makeCursorSdkCatalogTestLayer(() =>
            Effect.fail(
              new CursorSdkCatalogError({
                authenticationFailure: true,
                cause: new Error("unauthorized"),
              }),
            ),
          ),
        ),
      ),
    );

    expect(provider).toMatchObject({
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Cursor SDK authentication failed. Check CURSOR_API_KEY.",
    });
  });

  it("requires a Cursor API key without probing any external Cursor binary", async () => {
    const provider = await Effect.runPromise(
      checkCursorProviderStatus(baseCursorSettings).pipe(
        Effect.provide(
          makeCursorSdkCatalogTestLayer(() =>
            Effect.die("SDK catalog must not be used without CURSOR_API_KEY"),
          ),
        ),
      ),
    );

    expect(provider).toMatchObject({
      installed: true,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Cursor API key is required. Add CURSOR_API_KEY in provider settings.",
    });
  });
});
