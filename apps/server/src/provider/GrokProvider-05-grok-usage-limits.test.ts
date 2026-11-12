// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { GrokSettings } from "@t3tools/provider-grok/settings";

import {
  buildGrokModelCapabilities,
  checkGrokProviderStatus,
  grokSlashCommandsFromInitialize,
  parseGrokModelsCliOutput,
} from "@t3tools/provider-grok/testing";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { grokUsageResponseToLimits, readGrokAccount } from "@t3tools/provider-grok/testing";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const LOGGED_IN_MODELS_OUTPUT = [
  "You are logged in with grok.com.",
  "",
  "Default model: grok-4.6",
  "",
  "Available models:",
  "  * grok-4.6 (default)",
  "  - grok-4.5",
  "",
].join("\n");

const LOGGED_OUT_MODELS_OUTPUT = LOGGED_IN_MODELS_OUTPUT.replace(
  "You are logged in with grok.com.",
  "You are not authenticated.",
);









describe("Grok usage limits", () => {
  const checkedAt = "2026-09-16T00:00:00.000Z";
  const weeklyPeriod = {
    type: "USAGE_PERIOD_TYPE_WEEKLY",
    start: "2026-09-11T03:10:30.159171+00:00",
    end: "2026-09-18T03:10:30.159171+00:00",
  };

  it("shows zero usage for complete weekly and monthly periods with no percentage", () => {
    for (const [currentPeriod, kind, label, resetsAt] of [
      [weeklyPeriod, "weekly", "Weekly", "2026-09-18T03:10:30.159Z"],
      [
        {
          type: "USAGE_PERIOD_TYPE_MONTHLY",
          start: "2026-09-01T00:00:00.000Z",
          end: "2026-10-01T00:00:00.000Z",
        },
        "monthly",
        "Monthly",
        "2026-10-01T00:00:00.000Z",
      ],
    ] as const) {
      const response = { config: { currentPeriod } };
      expect
        .soft(grokUsageResponseToLimits(response, checkedAt).windows)
        .toEqual([{ id: "subscription", kind, label, usedPercent: 0, resetsAt }]);
    }
  });

  it("keeps incomplete, invalid, unordered, and unknown periods unreported", () => {
    for (const currentPeriod of [
      undefined,
      { ...weeklyPeriod, type: undefined },
      { ...weeklyPeriod, type: "USAGE_PERIOD_TYPE_DAILY" },
      { ...weeklyPeriod, start: undefined },
      { ...weeklyPeriod, end: undefined },
      { ...weeklyPeriod, start: "invalid" },
      { ...weeklyPeriod, end: "invalid" },
      { ...weeklyPeriod, start: weeklyPeriod.end },
      { ...weeklyPeriod, start: weeklyPeriod.end, end: weeklyPeriod.start },
    ]) {
      const response = { config: { currentPeriod } };
      expect
        .soft(grokUsageResponseToLimits(response, checkedAt).windows, JSON.stringify(response))
        .toEqual([]);
    }
  });

  // regression: #17061 show zero-use Grok billing periods
  it("rejects impossible calendar dates at either period boundary", () => {
    for (const [start, end] of [
      ["2026-02-30T00:00:00.000Z", "2026-03-09T00:00:00.000Z"],
      ["2026-02-23T00:00:00.000Z", "2026-02-30T00:00:00.000Z"],
    ]) {
      const response = { config: { currentPeriod: { ...weeklyPeriod, start, end } } };
      expect
        .soft(grokUsageResponseToLimits(response, checkedAt).windows, JSON.stringify(response))
        .toEqual([]);
    }
  });

  it("does not invent allowance or reset dates when billing omits them", () => {
    for (const response of [{}, { config: {} }, { config: { creditUsagePercent: NaN } }]) {
      const limits = grokUsageResponseToLimits(response, checkedAt);
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable).toBeUndefined();
    }
    expect(
      grokUsageResponseToLimits({ config: { creditUsagePercent: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "subscription", kind: "other", label: "Subscription", usedPercent: 0 }]);
    expect(
      grokUsageResponseToLimits(
        {
          config: {
            creditUsagePercent: 120,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "invalid" },
          },
        },
        checkedAt,
      ).windows,
    ).toEqual([{ id: "subscription", kind: "monthly", label: "Monthly", usedPercent: 100 }]);
  });
});

