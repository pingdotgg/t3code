import type { SDKModel } from "@cursor/sdk";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CursorSettings } from "../settings.ts";
import { CursorSettings as CursorSettingsSchema } from "../settings.ts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildCursorCapabilitiesFromSdkModel,
  buildCursorDiscoveredModelsFromSdk,
  buildCursorProviderSnapshot,
  checkCursorProviderStatus,
} from "./status.ts";
import * as CursorSdkCatalog from "./CursorSdkCatalog.ts";
import { CursorSdkError } from "./sdk.ts";

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
      supportsConversationRollback: false,
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
  it.effect("uses the SDK catalog when CURSOR_API_KEY is configured", () =>
    Effect.gen(function* () {
      const provider = yield* checkCursorProviderStatus(
        {
          ...baseCursorSettings,
          customModels: ["internal/cursor-model"],
        },
        { CURSOR_API_KEY: "test-cursor-key" },
      ).pipe(
        Effect.provide(
          CursorSdkCatalog.layerTest((apiKey) => {
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
    }),
  );

  it.effect("surfaces SDK authentication failures", () =>
    Effect.gen(function* () {
      const provider = yield* checkCursorProviderStatus(baseCursorSettings, {
        CURSOR_API_KEY: "invalid-test-key",
      }).pipe(
        Effect.provide(
          CursorSdkCatalog.layerTest(() =>
            Effect.fail(
              new CursorSdkCatalog.CursorSdkCatalogError({
                authenticationFailure: true,
                cause: new Error("unauthorized"),
              }),
            ),
          ),
        ),
      );

      expect(provider).toMatchObject({
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor SDK authentication failed. Check CURSOR_API_KEY.",
      });
    }),
  );

  it.effect.each([
    {
      authenticationType: "browser" as const,
      message:
        "Cursor needs a paid plan to run in T3 Code. Upgrade this account or sign in with a different one.",
    },
    {
      authenticationType: "api-key" as const,
      message:
        "Cursor needs a paid plan to run in T3 Code. Upgrade the account that owns CURSOR_API_KEY or use a key from a paid account.",
    },
  ])(
    "explains a rejected plan for $authenticationType authentication",
    ({ authenticationType, message }) =>
      Effect.gen(function* () {
        const provider = yield* checkCursorProviderStatus(
          baseCursorSettings,
          { CURSOR_API_KEY: "free-plan-key" },
          authenticationType,
        ).pipe(
          Effect.provide(
            CursorSdkCatalog.layerTest(() =>
              Effect.fail(
                new CursorSdkCatalog.CursorSdkCatalogError({
                  authenticationFailure: false,
                  cause: new CursorSdkError(
                    "[plan_required] Cloud Agent is not available for free users. Please upgrade to Pro.",
                    { code: "plan_required", status: 403 },
                  ),
                }),
              ),
            ),
          ),
        );

        expect(provider).toMatchObject({
          status: "error",
          auth: { status: "unknown" },
          message,
        });
      }),
  );

  it.effect.each([
    {
      name: "keeps models when /v1/me is blocked",
      meFailure: new CursorSdkError("[feature_unavailable] Not available for this team.", {
        code: "feature_unavailable",
        status: 403,
      }),
      expected: {
        status: "ready",
        auth: { status: "authenticated", type: "api-key", label: "Cursor API key" },
        models: [{ slug: "claude-opus-4-8", isCustom: false }],
      },
    },
    {
      name: "keeps models when /v1/me returns a 403 without a code",
      meFailure: new CursorSdkError("[unknown] Forbidden", { code: "unknown", status: 403 }),
      expected: {
        status: "ready",
        auth: { status: "authenticated", type: "api-key", label: "Cursor API key" },
        models: [{ slug: "claude-opus-4-8", isCustom: false }],
      },
    },
    {
      name: "keeps the paid-plan message when /v1/me returns plan_required",
      meFailure: new CursorSdkError("[plan_required] Not available for free users.", {
        code: "plan_required",
        status: 403,
      }),
      expected: {
        status: "error",
        auth: { status: "unknown" },
        message:
          "Cursor needs a paid plan to run in T3 Code. Upgrade the account that owns CURSOR_API_KEY or use a key from a paid account.",
      },
    },
    {
      name: "fails when /v1/me has a server error",
      meFailure: new CursorSdkError("[unknown] Service unavailable", {
        code: "unknown",
        status: 503,
      }),
      expected: {
        status: "error",
        auth: { status: "unknown" },
        message: "Cursor SDK catalog request failed. Check server logs for details.",
      },
    },
    {
      name: "rejects a 401 even when its code is feature_unavailable",
      meFailure: new CursorSdkError("Unauthorized", {
        code: "feature_unavailable",
        status: 401,
      }),
      expected: {
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor SDK authentication failed. Check CURSOR_API_KEY.",
      },
    },
    {
      name: "fails a key that /v1/me rejects",
      meFailure: new CursorSdkError("Unauthorized", { status: 401 }),
      expected: {
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor SDK authentication failed. Check CURSOR_API_KEY.",
      },
    },
  ])("$name", ({ meFailure, expected }) =>
    Effect.gen(function* () {
      const catalog = yield* CursorSdkCatalog.makeCursorSdkCatalog({
        readUser: () =>
          Effect.fail(
            new CursorSdkCatalog.CursorSdkCatalogError({
              authenticationFailure: meFailure.status === 401,
              cause: meFailure,
            }),
          ),
        readModels: () => Effect.succeed([sdkParameterizedModel]),
      });
      const provider = yield* checkCursorProviderStatus(baseCursorSettings, {
        CURSOR_API_KEY: "enterprise-key",
      }).pipe(Effect.provideService(CursorSdkCatalog.CursorSdkCatalog, catalog));

      expect(provider).toMatchObject(expected);
    }),
  );

  it.effect("requires a Cursor API key without probing any external Cursor binary", () =>
    Effect.gen(function* () {
      const provider = yield* checkCursorProviderStatus(baseCursorSettings).pipe(
        Effect.provide(
          CursorSdkCatalog.layerTest(() =>
            Effect.die("SDK catalog must not be used without CURSOR_API_KEY"),
          ),
        ),
      );

      expect(provider).toMatchObject({
        installed: true,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Sign in with Cursor or add CURSOR_API_KEY in provider settings.",
      });
    }),
  );
});
