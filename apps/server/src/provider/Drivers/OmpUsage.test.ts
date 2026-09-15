import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeOmpUsageOutput,
  ompUsageToAuth,
  ompUsageToLimits,
  probeOmpUsage,
  selectOmpBannerWindow,
} from "./OmpUsage.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";

const checkedAt = "2026-09-14T01:00:00.000Z";

const realisticPayload = JSON.stringify({
  generatedAt: "2026-09-14T00:00:00.000Z",
  reports: [
    {
      provider: "anthropic",
      fetchedAt: "2026-09-14T00:00:00.000Z",
      metadata: { accountId: "acct-1", email: "dev@example.com" },
      limits: [
        {
          id: "5h",
          label: "5-hour",
          scope: { provider: "anthropic", windowId: "5h", shared: false },
          window: {
            id: "5h",
            label: "5-hour",
            durationMs: 18_000_000,
            resetsAt: "2026-09-14T05:00:00.000Z",
          },
          amount: {
            used: 42,
            limit: 100,
            remaining: 58,
            usedFraction: 0.42,
            remainingFraction: 0.58,
            unit: "percent",
          },
          status: "ok",
        },
        {
          id: "7d",
          label: "7-day",
          scope: { provider: "anthropic", windowId: "7d", shared: false },
          window: {
            id: "7d",
            label: "7-day",
            durationMs: 604_800_000,
            resetsAt: "2026-09-20T00:00:00.000Z",
          },
          amount: {
            used: 15,
            limit: 100,
            remaining: 85,
            usedFraction: 0.15,
            remainingFraction: 0.85,
            unit: "percent",
          },
          status: "ok",
        },
      ],
    },
    {
      provider: "openai",
      fetchedAt: "2026-09-14T00:00:00.000Z",
      limits: [
        {
          id: "5h",
          label: "5-hour",
          scope: { provider: "openai", windowId: "5h", shared: false },
          window: {
            id: "5h",
            label: "5-hour",
            durationMs: 18_000_000,
            resetsAt: "2026-09-14T05:00:00.000Z",
          },
          amount: {
            used: 71,
            limit: 100,
            remaining: 29,
            usedFraction: 0.71,
            remainingFraction: 0.29,
            unit: "percent",
          },
          status: "ok",
        },
        {
          id: "7d",
          label: "7-day",
          scope: { provider: "openai", windowId: "7d", shared: true },
          window: {
            id: "7d",
            label: "7-day",
            durationMs: 604_800_000,
            resetsAt: "2026-09-21T00:00:00.000Z",
          },
          amount: {
            used: 20,
            limit: 100,
            remaining: 80,
            usedFraction: 0.2,
            remainingFraction: 0.8,
            unit: "percent",
          },
          status: "ok",
        },
      ],
    },
  ],
});

describe("ompUsageToLimits", () => {
  it("decodes two providers with 5h and 7d windows into stable per-provider rows", () => {
    expect(
      ompUsageToLimits({ payload: decodeOmpUsageOutput(realisticPayload), checkedAt }),
    ).toEqual({
      checkedAt,
      windows: [
        {
          id: "anthropic:5h",
          kind: "session",
          label: "anthropic · 5-hour",
          usedPercent: 42,
          resetsAt: "2026-09-14T05:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "openai:5h",
          kind: "session",
          label: "openai · 5-hour",
          usedPercent: 71,
          resetsAt: "2026-09-14T05:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "anthropic:7d",
          kind: "weekly",
          label: "anthropic · 7-day",
          usedPercent: 15,
          resetsAt: "2026-09-20T00:00:00.000Z",
          windowDurationMins: 10080,
        },
        {
          id: "openai:7d",
          kind: "weekly",
          label: "openai · 7-day",
          usedPercent: 20,
          resetsAt: "2026-09-21T00:00:00.000Z",
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("yields no limits for malformed, empty, or account-less payloads", () => {
    expect(
      ompUsageToLimits({ payload: decodeOmpUsageOutput("not json"), checkedAt }),
    ).toBeUndefined();
    expect(ompUsageToLimits({ payload: decodeOmpUsageOutput("{}"), checkedAt })).toBeUndefined();
    expect(
      ompUsageToLimits({ payload: decodeOmpUsageOutput('{"reports":[]}'), checkedAt }),
    ).toBeUndefined();
    expect(
      ompUsageToLimits({
        payload: decodeOmpUsageOutput('{"reports":[{"provider":"x","limits":[]}]}'),
        checkedAt,
      }),
    ).toBeUndefined();
  });

  it("drops expired windows but keeps the report's live ones", () => {
    const payload = decodeOmpUsageOutput(
      JSON.stringify({
        reports: [
          {
            provider: "anthropic",
            limits: [
              {
                id: "5h",
                window: { id: "5h", durationMs: 18_000_000, resetsAt: "2026-09-13T00:00:00.000Z" },
                amount: { usedFraction: 0.99 },
              },
              {
                id: "7d",
                window: { id: "7d", durationMs: 604_800_000, resetsAt: "2026-09-20T00:00:00.000Z" },
                amount: { usedFraction: 0.15 },
              },
            ],
          },
        ],
      }),
    );
    expect(ompUsageToLimits({ payload, checkedAt })?.windows.map((window) => window.id)).toEqual([
      "anthropic:7d",
    ]);
  });

  it("skips one malformed limit without losing its siblings", () => {
    const payload = decodeOmpUsageOutput(
      JSON.stringify({
        reports: [
          {
            provider: "anthropic",
            limits: [
              { id: "5h", amount: { nope: true }, extra: "tolerated" },
              {
                id: "7d",
                window: { id: "7d", durationMs: 604_800_000, resetsAt: "2026-09-20T00:00:00.000Z" },
                amount: { usedFraction: 0.15 },
              },
            ],
          },
        ],
      }),
    );
    expect(ompUsageToLimits({ payload, checkedAt })?.windows.map((window) => window.id)).toEqual([
      "anthropic:7d",
    ]);
  });
});

describe("selectOmpBannerWindow", () => {
  it("drives the banner from the most constrained live window", () => {
    const limits = ompUsageToLimits({ payload: decodeOmpUsageOutput(realisticPayload), checkedAt });
    expect(selectOmpBannerWindow(limits?.windows ?? [])?.id).toBe("openai:5h");
  });

  it("breaks spend ties toward the shorter window, then the smallest id", () => {
    expect(
      selectOmpBannerWindow([
        { id: "b:7d", kind: "weekly", label: "b", usedPercent: 50 },
        { id: "a:5h", kind: "session", label: "a", usedPercent: 50 },
        { id: "a:7d", kind: "weekly", label: "c", usedPercent: 50 },
      ])?.id,
    ).toBe("a:5h");
    expect(selectOmpBannerWindow([])).toBeUndefined();
  });
});

describe("epoch-millis timestamps", () => {
  // omp 18.1.18 emits `generatedAt`, `fetchedAt` and `resetsAt` as epoch
  // milliseconds. Decoding them as strings failed the whole payload and
  // reported unknown auth with no limits against a real install.
  const epochPayload = JSON.stringify({
    generatedAt: 1_789_401_597_111,
    reports: [
      {
        provider: "anthropic",
        fetchedAt: 1_789_401_435_347,
        metadata: { accountId: "acct-1", email: "dev@example.com" },
        limits: [
          {
            id: "anthropic:5h",
            label: "Claude 5 Hour",
            scope: { provider: "anthropic", windowId: "5h", shared: true },
            window: {
              id: "5h",
              label: "5 Hour",
              durationMs: 18_000_000,
              resetsAt: 4_102_444_800_000,
            },
            amount: { used: 29, limit: 100, usedFraction: 0.29, unit: "percent" },
            status: "ok",
          },
        ],
      },
    ],
  });

  it("decodes numeric timestamps into auth and live windows", () => {
    const payload = decodeOmpUsageOutput(epochPayload);
    expect(ompUsageToAuth(payload)).toEqual({
      status: "authenticated",
      type: "agent",
      email: "dev@example.com",
      label: "anthropic",
    });
    const limits = ompUsageToLimits({ payload, checkedAt });
    expect(limits?.windows.map((window) => window.id)).toEqual(["anthropic:5h"]);
    expect(limits?.windows[0]?.resetsAt).toBe("2100-01-01T00:00:00.000Z");
  });
});

describe("ompUsageToAuth", () => {
  it("reports authenticated with the provider list when accounts exist", () => {
    expect(ompUsageToAuth(decodeOmpUsageOutput(realisticPayload))).toEqual({
      status: "authenticated",
      type: "agent",
      email: "dev@example.com",
      label: "2 providers: anthropic, openai",
    });
  });

  it("omits the account address when omp reports none", () => {
    const redacted = JSON.stringify({ reports: [{ provider: "anthropic", limits: [] }] });
    expect(ompUsageToAuth(decodeOmpUsageOutput(redacted))).toEqual({
      status: "authenticated",
      type: "agent",
      label: "anthropic",
    });
  });

  it("stays unknown — never unauthenticated — when the probe cannot tell", () => {
    expect(ompUsageToAuth(undefined)).toEqual({ status: "unknown" });
    expect(ompUsageToAuth(decodeOmpUsageOutput("garbage"))).toEqual({ status: "unknown" });
    expect(ompUsageToAuth(decodeOmpUsageOutput('{"reports":[]}'))).toEqual({ status: "unknown" });
  });
});

const node = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >,
): Effect.Effect<A, E> => effect.pipe(Effect.provide(NodeServices.layer));

const writeUsageStub = Effect.fn("writeUsageStub")(function* (source: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "omp-usage-probe-",
  });
  return writeFakeCli({ directory: dir, name: "fake-omp", source });
});

describe("probeOmpUsage", () => {
  effectIt.live("returns auth and limits from a realistic usage payload", () =>
    Effect.gen(function* () {
      const binaryPath = yield* node(
        writeUsageStub(
          [
            'if (process.argv[2] === "usage" && process.argv[3] === "--json") {',
            // @effect-diagnostics-next-line preferSchemaOverJson:off - fake child-process stdout.
            `  process.stdout.write(${JSON.stringify(realisticPayload)});`,
            "  process.exit(0);",
            "}",
            'process.stderr.write("unexpected args\\n");',
            "process.exit(11);",
            "",
          ].join("\n"),
        ),
      );
      const result = yield* node(probeOmpUsage({ binaryPath }, checkedAt));
      expect(result.auth).toEqual({
        status: "authenticated",
        type: "agent",
        email: "dev@example.com",
        label: "2 providers: anthropic, openai",
      });
      expect(result.usageLimits?.windows.map((window) => window.id)).toEqual([
        "anthropic:5h",
        "openai:5h",
        "anthropic:7d",
        "openai:7d",
      ]);
    }),
  );

  effectIt.live("degrades to unknown auth with no limits when the CLI fails", () =>
    Effect.gen(function* () {
      const binaryPath = yield* node(
        writeUsageStub('process.stderr.write("unknown command\\n");\nprocess.exit(1);\n'),
      );
      expect(yield* node(probeOmpUsage({ binaryPath }, checkedAt))).toEqual({
        auth: { status: "unknown" },
      });
    }),
  );

  effectIt.live("degrades to unknown auth with no limits on malformed output", () =>
    Effect.gen(function* () {
      const binaryPath = yield* node(
        writeUsageStub('process.stdout.write("not json\\n");\nprocess.exit(0);\n'),
      );
      expect(yield* node(probeOmpUsage({ binaryPath }, checkedAt))).toEqual({
        auth: { status: "unknown" },
      });
    }),
  );
});
