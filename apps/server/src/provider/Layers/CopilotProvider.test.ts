import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { CopilotSettings } from "@t3tools/contracts";
import { DateTime, Effect, Schema } from "effect";
import { beforeEach, describe, vi } from "vitest";

import { checkCopilotProviderStatus } from "./CopilotProvider.ts";

const runtimeMock = vi.hoisted(() => {
  const state = {
    listModelsError: null as Error | null,
    createClientError: null as Error | null,
  };

  return {
    state,
    reset() {
      state.listModelsError = null;
      state.createClientError = null;
    },
  };
});

vi.mock("../copilotRuntime.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../copilotRuntime.ts")>("../copilotRuntime.ts");

  return {
    ...actual,
    createCopilotClient: vi.fn(() => {
      if (runtimeMock.state.createClientError) {
        throw runtimeMock.state.createClientError;
      }
      return {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        getStatus: vi.fn(async () => ({
          version: "1.0.32",
          protocolVersion: 3,
        })),
        getAuthStatus: vi.fn(async () => ({
          isAuthenticated: true,
          authType: "gh-cli",
          host: "https://github.com",
          statusMessage: "zortos293 (via gh)",
          login: "zortos293",
        })),
        listModels: vi.fn(async () => {
          if (runtimeMock.state.listModelsError) {
            throw runtimeMock.state.listModelsError;
          }
          return [];
        }),
      };
    }),
  };
});

beforeEach(() => {
  vi.useRealTimers();
  runtimeMock.reset();
});

const defaultCopilotSettings: CopilotSettings = Schema.decodeSync(CopilotSettings)({});

describe("CopilotProvider status", () => {
  it.effect("surfaces underlying SDK errors instead of leaking Effect.tryPromise text", () =>
    Effect.gen(function* () {
      runtimeMock.state.listModelsError = new Error("401 Unauthorized");

      const snapshot = yield* checkCopilotProviderStatus({
        settings: defaultCopilotSettings,
        cwd: process.cwd(),
      });

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, true);
      assert.equal(snapshot.message, "401 Unauthorized");
    }),
  );

  it.effect("returns an error snapshot when the configured Copilot CLI path is invalid", () =>
    Effect.gen(function* () {
      runtimeMock.state.createClientError = new Error(
        "The configured Copilot binary could not be found: /missing/copilot.",
      );

      const snapshot = yield* checkCopilotProviderStatus({
        settings: {
          ...defaultCopilotSettings,
          binaryPath: "/missing/copilot",
        },
        cwd: process.cwd(),
      });

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, false);
      assert.equal(
        snapshot.message,
        "The configured Copilot binary could not be started: /missing/copilot.",
      );
    }),
  );

  it.effect("timestamps each provider status check when the Effect executes", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"] });

      const statusCheck = checkCopilotProviderStatus({
        settings: defaultCopilotSettings,
        cwd: process.cwd(),
      });

      vi.setSystemTime(DateTime.makeUnsafe("2026-06-08T12:00:00.000Z").epochMilliseconds);
      const firstSnapshot = yield* statusCheck;

      vi.setSystemTime(DateTime.makeUnsafe("2026-06-08T12:01:00.000Z").epochMilliseconds);
      const secondSnapshot = yield* statusCheck;

      assert.equal(firstSnapshot.checkedAt, "2026-06-08T12:00:00.000Z");
      assert.equal(secondSnapshot.checkedAt, "2026-06-08T12:01:00.000Z");
    }),
  );
});
