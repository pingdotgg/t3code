import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import {
  assessCapacity,
  launchQuotaScope,
  refusedQuotaDomains,
  selectLaunchCandidate,
  isLaunchQuotaFailure,
} from "./DelegatedLaunchAdmission.ts";

const now = "2026-10-20T10:00:00.000Z";
const nowMs = Date.parse(now);

it.effect(
  "keeps unknown models and exhausted model windows from poisoning healthy models on the same account",
  () =>
    Effect.gen(function* () {
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const candidates = [
        selection("native", "unknown"),
        selection("native", "claude-sonnet-5-5"),
        selection("alias", "claude-opus-5-5"),
      ];
      for (const sharedExhausted of [false, true]) {
        const result = yield* selectLaunchCandidate({
          candidates,
          probe: (target) =>
            Effect.succeed({
              provider: {
                ...provider(target, "same@example.com", {
                  checkedAt: timestamp,
                  windows: [
                    {
                      id: "five_hour",
                      kind: "session",
                      label: "Session",
                      usedPercent: sharedExhausted ? 100 : 0,
                    },
                    { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 0 },
                    { id: "seven_day_sonnet", kind: "weekly", label: "Sonnet", usedPercent: 100 },
                  ],
                }),
                driver: ProviderDriverKind.make("claudeAgent"),
              },
              probeStartedAt: Date.parse(timestamp),
            }),
        });
        assert.equal(result.status, sharedExhausted ? "waiting" : "ready");
        if (result.status === "ready") assert.equal(result.selection.model, "claude-opus-5-5");
      }
    }),
);

it.effect("an unverified supported model does not block fresh evidence for another model", () =>
  Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const result = yield* selectLaunchCandidate({
      candidates: [selection("native", "gpt-spark"), selection("native")],
      probe: (target) =>
        Effect.succeed({
          provider: provider(target, "same@example.com", limits(0, timestamp)),
          probeStartedAt: Date.parse(timestamp),
        }),
    });
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.selection.model, "gpt-6.1-sol");
  }),
);

it.effect("admits actual global Kimi slugs only with their own complete usage evidence", () =>
  Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    for (const slug of ["k3", "kimi-for-coding-highspeed"]) {
      const target = selection("kimi_api", `kimi-code-plan-global/${slug}`);
      const result = yield* selectLaunchCandidate({
        candidates: [target],
        probe: () =>
          Effect.succeed({
            provider: {
              ...provider(target, undefined, {
                checkedAt: timestamp,
                credentialFingerprint: "global-credential",
                windows: ["limit_5h", "limit_month_total", "limit_month_code"].map((id) => ({
                  id,
                  kind: "session" as const,
                  label: id,
                  usedPercent: 0,
                })),
              }),
              driver: ProviderDriverKind.make("opencode"),
            },
            probeStartedAt: Date.parse(timestamp),
          }),
      });
      assert.equal(result.status, "ready");
    }
  }),
);
function limits(usedPercent = 0, checkedAt = now): ServerProviderUsageLimits {
  return {
    checkedAt,
    windows: [
      { id: "primary", label: "Session", kind: "session", usedPercent },
      { id: "secondary", label: "Weekly", kind: "weekly", usedPercent: 0 },
    ],
  };
}
const selection = (instance: string, model = "gpt-6.1-sol"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instance),
  model,
});
function provider(
  target: ModelSelection,
  email: string | undefined,
  usageLimits: ServerProviderUsageLimits,
): ServerProvider {
  return {
    instanceId: target.instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", ...(email ? { email } : {}) },
    checkedAt: usageLimits.checkedAt,
    usageLimits,
    models: [{ slug: target.model, name: target.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
}

describe("capacity evidence", () => {
  it("requires fresh complete evidence and rejects failed-refresh bars", () => {
    expect(assessCapacity(limits(), "codex", "gpt-6.1-sol", nowMs, nowMs)).toBe("healthy");
    for (const value of [
      undefined,
      limits(0, "invalid"),
      limits(0, "2026-10-20T09:59:59.999Z"),
      limits(0, "2026-10-20T10:00:00.001Z"),
      { ...limits(), windows: limits().windows.slice(0, 1) },
      { ...limits(), unavailable: { reason: "probeFailed" as const } },
      { ...limits(), unavailable: { reason: "unsupported" as const } },
      {
        ...limits(),
        windows: [{ ...limits().windows[0]!, usedPercent: Number.NaN }, limits().windows[1]!],
      },
    ])
      expect(assessCapacity(value, "codex", "gpt-6.1-sol", nowMs, nowMs)).toBe("unverified");
    expect(assessCapacity(limits(), "codex", "gpt-6.1-sol", nowMs, nowMs + 30_001)).toBe(
      "unverified",
    );
    expect(assessCapacity(limits(), "acpRegistry", "gpt-6.1-sol", nowMs, nowMs)).toBe("unverified");
    expect(assessCapacity(limits(), "codex", "gpt-spark", nowMs, nowMs)).toBe("unverified");
  });
  it("distinguishes account limits from relevant Claude model limits", () => {
    const base = {
      checkedAt: now,
      windows: [
        { id: "five_hour", kind: "session" as const, label: "Session", usedPercent: 0 },
        { id: "seven_day", kind: "weekly" as const, label: "Weekly", usedPercent: 0 },
        { id: "seven_day_sonnet", kind: "weekly" as const, label: "Sonnet", usedPercent: 100 },
      ],
    };
    expect(assessCapacity(base, "claudeAgent", "claude-sonnet-4-6", nowMs, nowMs)).toBe(
      "exhausted",
    );
    expect(assessCapacity(base, "claudeAgent", "claude-opus-4-7", nowMs, nowMs)).toBe("healthy");
    expect(
      assessCapacity(
        {
          ...base,
          windows: base.windows.map((w) => (w.id === "seven_day" ? { ...w, usedPercent: 100 } : w)),
        },
        "claudeAgent",
        "claude-opus-4-7",
        nowMs,
        nowMs,
      ),
    ).toBe("exhausted");
  });
});

it.effect(
  "skips Sol/Astra aliases of the exhausted account and selects the first independent healthy route",
  () =>
    Effect.gen(function* () {
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const candidates = [
        selection("codex"),
        selection("alias", "gpt-6-astra"),
        selection("alternate"),
        selection("unused"),
      ];
      const probes: Array<string> = [];
      const result = yield* selectLaunchCandidate({
        candidates,
        probe: (target) =>
          Effect.sync(() => {
            probes.push(target.instanceId);
            return {
              provider: provider(
                target,
                target.instanceId === "alternate" ? "other@example.com" : "same@example.com",
                limits(target.instanceId === "codex" ? 100 : 0, timestamp),
              ),
              probeStartedAt: Date.parse(timestamp),
            };
          }),
      });
      assert.equal(result.status, "ready");
      if (result.status === "ready") assert.equal(result.selection.instanceId, "alternate");
      assert.deepEqual(probes, ["codex", "alias", "alternate"]);
    }),
);

it.effect("does not invent independent accounts from different binding IDs", () =>
  Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const result = yield* selectLaunchCandidate({
      candidates: [selection("a"), selection("b")],
      probe: (target) =>
        Effect.succeed({
          provider: provider(target, undefined, limits(0, timestamp)),
          binding: target.instanceId,
          probeStartedAt: Date.parse(timestamp),
        }),
    });
    assert.equal(result.status, "waiting");
  }),
);

it.effect("parallel denials start no workers and return bounded waiting", () =>
  Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    let starts = 0;
    const dispatch = selectLaunchCandidate({
      candidates: [selection("a")],
      probe: (target) =>
        Effect.succeed({
          provider: provider(target, "same@example.com", limits(100, timestamp)),
          probeStartedAt: Date.parse(timestamp),
        }),
    }).pipe(
      Effect.tap((decision) =>
        Effect.sync(() => {
          if (decision.status === "ready") starts++;
        }),
      ),
    );
    const results = yield* Effect.all([dispatch, dispatch], { concurrency: "unbounded" });
    assert.equal(starts, 0);
    assert.isTrue(
      results.every(
        (r) => r.status === "waiting" && Date.parse(r.retryAt) === Date.parse(timestamp) + 60_000,
      ),
    );
  }),
);

it.effect("times out a hung read-only probe and continues in route order", () =>
  Effect.gen(function* () {
    const candidates = [selection("hung"), selection("healthy")];
    const fiber = yield* selectLaunchCandidate({
      candidates,
      probe: (target) =>
        target.instanceId === "hung"
          ? Effect.never
          : Effect.gen(function* () {
              const timestamp = DateTime.formatIso(yield* DateTime.now);
              return {
                provider: provider(target, "healthy@example.com", limits(0, timestamp)),
                probeStartedAt: Date.parse(timestamp),
              };
            }),
    }).pipe(Effect.forkChild);
    yield* TestClock.adjust("8 seconds");
    const result = yield* Fiber.join(fiber);
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.selection.instanceId, "healthy");
  }),
);

it.effect(
  "skips a domain rejected by the first provider request despite a healthy usage response",
  () =>
    Effect.gen(function* () {
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const result = yield* selectLaunchCandidate({
        candidates: [selection("a"), selection("alias", "gpt-6-astra")],
        blockedDomains: ["codex:account:same@example.com"],
        probe: (target) =>
          Effect.succeed({
            provider: provider(target, "same@example.com", limits(0, timestamp)),
            probeStartedAt: Date.parse(timestamp),
          }),
      });
      assert.equal(result.status, "waiting");
    }),
);

it("uses structured quota causes and preserves unrelated start errors", () => {
  expect(isLaunchQuotaFailure({ cause: { failure: { class: "usage_limit" } } })).toBe(true);
  expect(isLaunchQuotaFailure(new Error("usage limit reached"))).toBe(false);
  expect(isLaunchQuotaFailure({ failure: { class: "provider_error" } })).toBe(false);
});

it.effect(
  "blocks a refused shared Claude account despite a lagging healthy alternate-model snapshot",
  () =>
    Effect.gen(function* () {
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const sonnet = selection("native", "claude-sonnet-5-5");
      const opus = selection("alias", "claude-opus-5-5");
      const probe = (target: ModelSelection) =>
        Effect.succeed({
          provider: {
            ...provider(target, "same@example.com", {
              checkedAt: timestamp,
              windows: ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus"].map(
                (id) => ({
                  id,
                  label: id,
                  kind: "weekly" as const,
                  usedPercent: 0,
                }),
              ),
            }),
            driver: ProviderDriverKind.make("claudeAgent"),
          },
          probeStartedAt: Date.parse(timestamp),
        });
      const admitted = yield* selectLaunchCandidate({ candidates: [sonnet], probe });
      assert.equal(admitted.status, "ready");
      if (admitted.status !== "ready") return;
      for (const failure of [
        { class: "usage_limit" },
        { class: "usage_limit", quotaScope: { type: "account" } },
        { class: "usage_limit", quotaScope: { type: "window", windowId: "unproven" } },
      ]) {
        const decision = yield* selectLaunchCandidate({
          candidates: [opus],
          probe,
          blockedDomains: refusedQuotaDomains(admitted.domains, launchQuotaScope(failure)),
        });
        assert.equal(decision.status, "waiting");
      }
      const scoped = refusedQuotaDomains(admitted.domains, {
        type: "window",
        windowId: "seven_day_sonnet",
      });
      assert.equal(
        (yield* selectLaunchCandidate({ candidates: [sonnet], probe, blockedDomains: scoped }))
          .status,
        "waiting",
      );
      assert.equal(
        (yield* selectLaunchCandidate({ candidates: [opus], probe, blockedDomains: scoped }))
          .status,
        "ready",
      );
    }),
);

it.effect("does not narrow a Claude refusal to an absent model window", () =>
  Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const sonnet = selection("native", "claude-sonnet-5-5");
    const admitted = yield* selectLaunchCandidate({
      candidates: [sonnet],
      probe: (target) =>
        Effect.succeed({
          provider: {
            ...provider(target, "same@example.com", {
              checkedAt: timestamp,
              windows: ["five_hour", "seven_day"].map((id) => ({
                id,
                label: id,
                kind: "weekly" as const,
                usedPercent: 0,
              })),
            }),
            driver: ProviderDriverKind.make("claudeAgent"),
          },
          probeStartedAt: Date.parse(timestamp),
        }),
    });
    assert.equal(admitted.status, "ready");
    if (admitted.status !== "ready") return;
    assert.deepEqual(
      refusedQuotaDomains(admitted.domains, { type: "window", windowId: "seven_day_sonnet" }),
      ["claudeAgent:account:same@example.com"],
    );
  }),
);

it.effect("keeps attempted direct aliases out of routing without an exhaustion diagnosis", () =>
  Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const result = yield* selectLaunchCandidate({
      candidates: [selection("a"), selection("alias", "gpt-6-astra")],
      blockedDomains: ["launch:attempt:codex:account:same@example.com"],
      probe: (target) =>
        Effect.succeed({
          provider: provider(target, "same@example.com", limits(0, timestamp)),
          probeStartedAt: Date.parse(timestamp),
        }),
    });
    assert.equal(result.status, "waiting");
    if (result.status === "waiting") assert.equal(result.reason, "throttled");
  }),
);
