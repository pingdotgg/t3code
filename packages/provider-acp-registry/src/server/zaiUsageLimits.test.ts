import { describe, expect, it } from "@effect/vitest";

import {
  GLM_READ_FAILED_MESSAGE,
  ZAI_GLM_AGENT_ID,
  glmSignIn,
  glmUpdateRequiredLimits,
  isZaiUsageLimitsInstance,
  mapGlmUsageLimits,
  readGlmUsageCapability,
} from "./zaiUsageLimits.ts";
import { AcpRegistrySettings } from "../settings.ts";
import * as Schema from "effect/Schema";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const READ_AT = "2026-11-05T22:29:30.000Z";
const ZAI_USAGE = {
  label: "Z.ai usage",
  url: "https://z.ai/manage-apikey/coding-plan/personal/my-plan",
};

const GLM_USAGE_FIXTURE = {
  version: 1,
  checkedAt: "2026-11-05T22:29:01.960Z",
  stale: false,
  windows: [
    {
      id: "time_limit-5-1",
      label: "MCP quota",
      kind: "other",
      usedPercent: 4,
      used: 150,
      limit: 4000,
      remaining: 3850,
      unit: "calls",
      resetsAt: "2026-11-30T20:12:01.999Z",
    },
    {
      id: "tokens_limit-3-5",
      label: "5-hour Model quota",
      kind: "session",
      usedPercent: 27,
      windowDurationMins: 300,
      resetsAt: "2026-11-06T01:07:46.158Z",
    },
  ],
};

const map = (result: unknown, environment: NodeJS.ProcessEnv = {}) =>
  mapGlmUsageLimits({ result, environment, readAt: READ_AT });

describe("mapGlmUsageLimits", () => {
  it("maps the agent's response to its two windows, sorted by kind", () => {
    expect(map(GLM_USAGE_FIXTURE)).toEqual({
      checkedAt: "2026-11-05T22:29:01.960Z",
      windows: [
        {
          id: "tokens_limit-3-5",
          kind: "session",
          label: "5-hour Model quota",
          usedPercent: 27,
          windowDurationMins: 300,
          resetsAt: "2026-11-06T01:07:46.158Z",
        },
        {
          id: "time_limit-5-1",
          kind: "other",
          label: "MCP quota",
          usedPercent: 4,
          resetsAt: "2026-11-30T20:12:01.999Z",
          blocksModel: false,
        },
      ],
      externalUsage: ZAI_USAGE,
    });
  });

  it("maps a weekly credit window through", () => {
    const limits = map({
      checkedAt: "2026-11-05T22:29:01.960Z",
      windows: [
        {
          id: "credit_limit-6-1",
          label: "1-week Model quota",
          kind: "weekly",
          usedPercent: 64,
          windowDurationMins: 10080,
        },
      ],
    });
    expect(limits.unavailable).toBeUndefined();
    expect("credentialFingerprint" in limits).toBe(false);
    expect(limits.windows).toEqual([
      {
        id: "credit_limit-6-1",
        kind: "weekly",
        label: "1-week Model quota",
        usedPercent: 64,
        windowDurationMins: 10080,
      },
    ]);
    expect("blocksModel" in limits.windows[0]!).toBe(false);
  });

  it("skips malformed windows and drops invalid resetsAt and windowDurationMins", () => {
    const limits = map({
      windows: [
        { label: "missing id", kind: "session", usedPercent: 10 },
        { id: "missing-label", kind: "session", usedPercent: 10 },
        { id: "  ", label: "Blank id", kind: "session", usedPercent: 10 },
        { id: "blank-label", label: "", kind: "session", usedPercent: 10 },
        { id: "missing-percent", label: "Session", kind: "session" },
        "not an object",
        null,
        {
          id: "tokens_limit-3-5",
          label: "5-hour Model quota",
          kind: "session",
          usedPercent: 27,
          resetsAt: "not a date",
          windowDurationMins: -5,
        },
        {
          id: "credit_limit-6-1",
          label: "1-week Model quota",
          kind: "weekly",
          usedPercent: 120,
          windowDurationMins: 1.5,
        },
        { id: "mystery", label: "Mystery", kind: "fortnightly", usedPercent: 50 },
      ],
    });
    expect(limits.windows).toEqual([
      {
        id: "tokens_limit-3-5",
        kind: "session",
        label: "5-hour Model quota",
        usedPercent: 27,
      },
      {
        id: "credit_limit-6-1",
        kind: "weekly",
        label: "1-week Model quota",
        usedPercent: 100,
      },
      { id: "mystery", kind: "other", label: "Mystery", usedPercent: 50 },
    ]);
  });

  it("keeps at most 64 windows", () => {
    const windows = Array.from({ length: 70 }, (_, index) => ({
      id: `time_limit-${index}-1`,
      label: "MCP quota",
      kind: "other",
      usedPercent: index % 100,
    }));
    const limits = map({ windows });
    expect(limits.windows).toHaveLength(64);
    expect(limits.windows.some((window) => window.id === "time_limit-63-1")).toBe(true);
    expect(limits.windows.some((window) => window.id === "time_limit-64-1")).toBe(false);
    expect(limits.windows.every((window) => window.blocksModel === false)).toBe(true);
  });

  it.each([
    { reason: "missingCredentials", expected: "unsupported", external: true },
    { reason: "unsupportedEndpoint", expected: "unsupported", external: true },
    { reason: "authenticationFailed", expected: "probeFailed", external: false },
    { reason: "requestFailed", expected: "probeFailed", external: false },
    { reason: "invalidResponse", expected: "probeFailed", external: false },
    { reason: "somethingNew", expected: "probeFailed", external: false },
  ] as const)("maps unavailable $reason to $expected", ({ reason, expected, external }) => {
    const limits = map({
      checkedAt: "2026-11-05T22:29:01.960Z",
      windows: [],
      unavailable: { reason, message: "  The agent's own explanation.  " },
    });
    expect(limits.windows).toEqual([]);
    expect(limits.unavailable).toEqual({
      reason: expected,
      message: "The agent's own explanation.",
    });
    expect(limits.externalUsage === undefined).toBe(!external);
  });

  it("trims and caps long agent messages", () => {
    const limits = map({
      unavailable: { reason: "requestFailed", message: `  ${"x".repeat(400)}  ` },
    });
    expect(limits.unavailable?.message).toHaveLength(300);
  });

  it("falls back to fixed messages when the agent sends none", () => {
    expect(map({ unavailable: { reason: "missingCredentials" } }).unavailable).toEqual({
      reason: "unsupported",
      message: "GLM Agent reported no Coding Plan limits.",
    });
    expect(map({ unavailable: { reason: "requestFailed" } }).unavailable).toEqual({
      reason: "probeFailed",
      message: GLM_READ_FAILED_MESSAGE,
    });
  });

  it("keeps a stale result's windows and their checkedAt", () => {
    const limits = map({
      checkedAt: "2026-11-05T20:00:00.000Z",
      stale: true,
      windows: GLM_USAGE_FIXTURE.windows,
    });
    expect(limits.checkedAt).toBe("2026-11-05T20:00:00.000Z");
    expect(limits.windows).toHaveLength(2);
    expect(limits.unavailable).toBeUndefined();
  });

  it("uses the read time when checkedAt is not a valid date", () => {
    expect(map({ checkedAt: "yesterday", windows: GLM_USAGE_FIXTURE.windows }).checkedAt).toBe(
      READ_AT,
    );
    expect(map({ windows: GLM_USAGE_FIXTURE.windows }).checkedAt).toBe(READ_AT);
  });

  it("reports an undecodable result as a failed read", () => {
    for (const result of ["not an object", null, 42]) {
      expect(map(result)).toEqual({
        checkedAt: READ_AT,
        windows: [],
        unavailable: { reason: "probeFailed", message: GLM_READ_FAILED_MESSAGE },
      });
    }
  });

  it("points BigModel accounts at the BigModel usage page", () => {
    for (const baseUrl of [
      "https://open.bigmodel.cn/api/anthropic",
      "https://dev.bigmodel.cn/api/anthropic",
    ]) {
      expect(map(GLM_USAGE_FIXTURE, { ACP_GLM_BASE_URL: baseUrl }).externalUsage).toEqual({
        label: "Z.ai usage",
        url: "https://bigmodel.cn/coding-plan/personal/usage",
      });
    }
    for (const environment of [
      {},
      { ACP_GLM_BASE_URL: "https://api.z.ai/api/anthropic" },
      { ACP_GLM_BASE_URL: "https://glm.example.test/v1" },
    ]) {
      expect(map(GLM_USAGE_FIXTURE, environment).externalUsage).toEqual(ZAI_USAGE);
    }
  });
});

describe("glmSignIn", () => {
  it.each([
    ["a reply with windows", GLM_USAGE_FIXTURE, true],
    ["a reply with no windows", { version: 1, windows: [] }, true],
    ["missing credentials", { windows: [], unavailable: { reason: "missingCredentials" } }, false],
    [
      "rejected credentials",
      { windows: [], unavailable: { reason: "authenticationFailed" } },
      false,
    ],
    ["a failed request", { windows: [], unavailable: { reason: "requestFailed" } }, undefined],
    [
      "an unsupported endpoint",
      { windows: [], unavailable: { reason: "unsupportedEndpoint" } },
      undefined,
    ],
    ["an undecodable reply", "not an object", undefined],
  ])("reads sign-in from %s", (_name, result, expected) => {
    expect(glmSignIn(result)).toBe(expected);
  });
});

describe("glmUpdateRequiredLimits", () => {
  it("carries the usage link that makes its update message visible", () => {
    expect(glmUpdateRequiredLimits({ environment: {}, checkedAt: READ_AT })).toEqual({
      checkedAt: READ_AT,
      windows: [],
      unavailable: {
        reason: "unsupported",
        message: "Update GLM Agent to 1.16 or newer to see Coding Plan limits.",
      },
      externalUsage: ZAI_USAGE,
    });
  });
});

describe("readGlmUsageCapability", () => {
  const capability = { version: 1, method: "_glm/usage" };
  it.each([
    {
      name: "advertised",
      initialize: { agentCapabilities: { _meta: { "glm-acp-agent/usage": capability } } },
      expected: true,
    },
    {
      name: "with extra fields",
      initialize: {
        agentCapabilities: { _meta: { "glm-acp-agent/usage": { ...capability, future: true } } },
      },
      expected: true,
    },
    { name: "no capabilities", initialize: {}, expected: false },
    { name: "no _meta", initialize: { agentCapabilities: {} }, expected: false },
    { name: "null _meta", initialize: { agentCapabilities: { _meta: null } }, expected: false },
    { name: "missing key", initialize: { agentCapabilities: { _meta: {} } }, expected: false },
    {
      name: "wrong version",
      initialize: {
        agentCapabilities: { _meta: { "glm-acp-agent/usage": { ...capability, version: 2 } } },
      },
      expected: false,
    },
    {
      name: "wrong method",
      initialize: {
        agentCapabilities: {
          _meta: { "glm-acp-agent/usage": { ...capability, method: "_glm/other" } },
        },
      },
      expected: false,
    },
    {
      name: "non-object value",
      initialize: { agentCapabilities: { _meta: { "glm-acp-agent/usage": true } } },
      expected: false,
    },
  ])("is $expected when $name", ({ initialize, expected }) => {
    expect(readGlmUsageCapability(initialize)).toBe(expected);
  });
});

describe("isZaiUsageLimitsInstance", () => {
  it("matches only enabled registry glm-acp-agent instances", () => {
    expect(isZaiUsageLimitsInstance(decodeSettings({ agentId: ZAI_GLM_AGENT_ID }))).toBe(true);
    expect(isZaiUsageLimitsInstance(decodeSettings({ agentId: ` ${ZAI_GLM_AGENT_ID} ` }))).toBe(
      true,
    );
    expect(isZaiUsageLimitsInstance(decodeSettings({ agentId: "kimi-acp" }))).toBe(false);
    expect(isZaiUsageLimitsInstance(decodeSettings({ source: "local", commandPath: "glm" }))).toBe(
      false,
    );
    expect(
      isZaiUsageLimitsInstance(decodeSettings({ agentId: ZAI_GLM_AGENT_ID, enabled: false })),
    ).toBe(false);
  });
});
