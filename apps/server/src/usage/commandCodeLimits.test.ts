// @effect-diagnostics globalDate:off -- compare fixture epoch ms against standard ISO.
// @effect-diagnostics nodeBuiltinImport:off -- isolated fake auth file for HTTP tests.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { UsageLimitSourceSnapshot } from "@t3tools/contracts";
import {
  commandCodeMonthlyWindow,
  commandCodeWindows,
  readCommandCodeLimitSource,
} from "./commandCodeLimits.ts";

const encodeUsageLimitSourceSnapshot = Schema.encodeSync(UsageLimitSourceSnapshot);

describe("Command Code rolling quota windows", () => {
  it("derives current billing-cycle monthly usage from remaining and consumed credits", () => {
    assert.deepStrictEqual(
      commandCodeMonthlyWindow(
        { credits: { monthlyCredits: 20, purchasedCredits: 100, freeCredits: 40 } },
        {
          data: {
            status: "active",
            planId: "individual-goat",
            currentPeriodStart: "2026-11-01T00:00:00.000Z",
            currentPeriodEnd: "2026-12-01T00:00:00.000Z",
          },
        },
        {
          periodBasis: "billing-period",
          periodStart: "2026-11-01T00:00:00.000Z",
          totalMonthlyCredits: 10,
          totalCredits: 90,
        },
      ),
      {
        id: "command_monthly",
        kind: "monthly",
        label: "Monthly plan credits",
        usedPercent: (10 / 30) * 100,
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
    );
  });
  it("does not guess monthly credits for inactive, mismatched or malformed billing periods", () => {
    const credits = { credits: { monthlyCredits: 20, monthlyCreditsTotal: 30 } };
    const active = {
      status: "active",
      planId: "individual-pro",
      currentPeriodStart: "2026-11-01T00:00:00.000Z",
      currentPeriodEnd: "2026-12-01T00:00:00.000Z",
    };
    const currentCycle = {
      periodBasis: "billing-period",
      periodStart: "2026-11-01T00:00:00.000Z",
      totalMonthlyCredits: 10,
    };
    for (const data of [
      { ...active, status: "cancelled" },
      { ...active, currentPeriodEnd: null },
    ])
      assert.isNull(commandCodeMonthlyWindow(credits, { data }, currentCycle));
    assert.isNull(
      commandCodeMonthlyWindow(
        { credits: { monthlyCredits: 31, monthlyCreditsTotal: 30 } },
        { data: active },
        currentCycle,
      ),
    );
    // Plan IDs and published advertised values cannot substitute for an API-reported allowance.
    assert.isNull(commandCodeMonthlyWindow({ credits: { monthlyCredits: 20 } }, { data: active }));
    assert.isNull(
      commandCodeMonthlyWindow(
        { credits: { monthlyCredits: 20, monthlyCreditsTotal: 0 } },
        { data: active },
        currentCycle,
      ),
    );
    assert.isNull(commandCodeMonthlyWindow({}, { data: active }));
    const noTotal = { credits: { monthlyCredits: 20 } };
    // A reported allowance does not prove that its remaining credits belong
    // to the active billing cycle without a matching monthly usage summary.
    assert.isNull(commandCodeMonthlyWindow(credits, { data: active }));
    assert.isNull(
      commandCodeMonthlyWindow(
        credits,
        { data: active },
        {
          ...currentCycle,
          periodStart: "2026-10-01T00:00:00.000Z",
        },
      ),
    );
    assert.isNull(
      commandCodeMonthlyWindow(
        credits,
        { data: active },
        {
          ...currentCycle,
          periodBasis: "calendar-month",
        },
      ),
    );
    assert.isNull(
      commandCodeMonthlyWindow(
        credits,
        { data: active },
        {
          ...currentCycle,
          totalMonthlyCredits: Number.NaN,
        },
      ),
    );
    assert.deepStrictEqual(
      commandCodeMonthlyWindow(credits, { data: active }, currentCycle)?.usedPercent,
      (10 / 30) * 100,
    );
    assert.isNull(
      commandCodeMonthlyWindow(
        noTotal,
        { data: active },
        { ...currentCycle, totalMonthlyCredits: -1 },
      ),
    );
    assert.isNull(
      commandCodeMonthlyWindow(
        noTotal,
        { data: active },
        { ...currentCycle, totalMonthlyCredits: Number.NaN },
      ),
    );
    assert.isNull(
      commandCodeMonthlyWindow(
        noTotal,
        { data: active },
        { ...currentCycle, periodBasis: "calendar-month" },
      ),
    );
    assert.isNull(
      commandCodeMonthlyWindow(
        noTotal,
        { data: active },
        { ...currentCycle, periodStart: "2026-10-01T00:00:00.000Z" },
      ),
    );
    assert.isNull(commandCodeMonthlyWindow(noTotal, { data: active }, { totalCost: 10 }));
    assert.isNull(
      commandCodeMonthlyWindow(
        { credits: { monthlyCredits: 0 } },
        { data: active },
        { ...currentCycle, totalMonthlyCredits: 0 },
      ),
    );
    assert.deepStrictEqual(
      commandCodeMonthlyWindow(
        noTotal,
        { data: { ...active, planId: "unknown-new-plan" } },
        currentCycle,
      )?.usedPercent,
      (10 / 30) * 100,
    );
  });

  it("uses API reported usage and cap rather than plan or token estimates", () => {
    const windows = commandCodeWindows({
      windowLimits: {
        limited: true,
        fiveHour: { used: 0.25, cap: 14, resetAt: 1793509560432 },
        weekly: { used: 0.7, cap: 35, resetAt: 1794078357384 },
      },
    });
    assert.lengthOf(windows, 2);
    assert.strictEqual(windows[0]?.kind, "session");
    assert.closeTo(windows[0]!.usedPercent, (0.25 / 14) * 100, 0.000001);
    assert.strictEqual(windows[0]?.windowDurationMins, 300);
    assert.strictEqual(windows[0]?.resetsAt, new Date(1793509560432).toISOString());
    assert.strictEqual(windows[1]?.kind, "weekly");
    assert.closeTo(windows[1]!.usedPercent, (0.7 / 35) * 100, 0.000001);
  });

  it("does not invent windows for PAYG or malformed/unavailable quotas", () => {
    assert.deepStrictEqual(commandCodeWindows({ windowLimits: { limited: false } }), []);
    assert.deepStrictEqual(commandCodeWindows({}), []);
    assert.deepStrictEqual(
      commandCodeWindows({ windowLimits: { fiveHour: { used: 20, cap: 0, resetAt: null } } }),
      [],
    );
  });

  it("clamps over-used windows without pretending missing reset times exist", () => {
    assert.deepStrictEqual(
      commandCodeWindows({ windowLimits: { fiveHour: { used: 11, cap: 10, resetAt: null } } }),
      [
        {
          id: "command_five_hour",
          kind: "session",
          label: "5 hours",
          usedPercent: 100,
          windowDurationMins: 300,
        },
      ],
    );
  });

  it("encodes the Command Code limit snapshot in the existing stream contract", () => {
    const snapshot = encodeUsageLimitSourceSnapshot({
      id: "command-code-local" as typeof UsageLimitSourceSnapshot.Type.id,
      kind: "cliproxy",
      label: "Command Code",
      checkedAt: "2026-11-01T03:00:00.000Z",
      accounts: [
        {
          id: "Command Code",
          driver:
            "command-code" as (typeof UsageLimitSourceSnapshot.Type.accounts)[number]["driver"],
          usageLimits: {
            checkedAt: "2026-11-01T03:00:00.000Z",
            windows: commandCodeWindows({
              windowLimits: { weekly: { used: 3, cap: 35, resetAt: 1794078357384 } },
            }),
          },
        },
      ],
    });
    assert.strictEqual(snapshot.kind, "cliproxy");
    assert.lengthOf(snapshot.accounts, 1);
  });

  it.effect("reads true windows using the expected CLI API origin and organization", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cmd-limits-")),
      );
      const authPath = NodePath.join(dir, "auth.json");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(authPath, JSON.stringify({ apiKey: "testing-only-key" }), {
          mode: 0o600,
        }),
      );
      const visited: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          visited.push(request.url);
          if (request.url.includes("whoami"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ success: true, org: { id: "org-for-test" } }),
            );
          if (request.url.includes("subscriptions"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: {
                  status: "active",
                  planId: "individual-pro",
                  currentPeriodStart: "2026-11-01T00:00:00.000Z",
                  currentPeriodEnd: "2026-12-01T00:00:00.000Z",
                },
              }),
            );
          if (request.url.includes("/alpha/usage/summary"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                periodBasis: "billing-period",
                periodStart: "2026-11-01T00:00:00.000Z",
                totalMonthlyCredits: 15,
                totalCredits: 100,
              }),
            );
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              credits: { monthlyCredits: 15, purchasedCredits: 200 },
              windowLimits: {
                fiveHour: { used: 3, cap: 14, resetAt: 1793509560432 },
                weekly: { used: 7, cap: 35, resetAt: 1794078357384 },
              },
            }),
          );
        }),
      );
      try {
        const source = yield* readCommandCodeLimitSource({ authPath }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provide([NodeServices.layer, NodeCrypto.layer]),
        );
        assert.isNotNull(source);
        assert.strictEqual(source.kind, "cliproxy");
        assert.strictEqual(source.accounts[0]?.driver, "command-code");
        assert.isFalse("error" in source);
        assert.equal(source.accounts[0]?.workspaceId, "org-for-test");
        assert.match(source.accounts[0]?.usageLimits.credentialFingerprint ?? "", /^[a-f0-9]{64}$/);
        assert.deepStrictEqual(
          source.accounts[0]?.usageLimits.windows.map((w) => w.usedPercent),
          [(3 / 14) * 100, 20, 50],
        );
        assert.deepStrictEqual(visited, [
          "https://api.commandcode.ai/alpha/whoami?limits=1",
          "https://api.commandcode.ai/alpha/billing/credits?orgId=org-for-test",
          "https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-for-test",
          "https://api.commandcode.ai/alpha/usage/summary?orgId=org-for-test",
        ]);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
  );

  it.effect(
    "keeps rolling windows if optional billing times out after a slow identity request",
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cmd-limits-")),
        );
        const authPath = NodePath.join(dir, "auth.json");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(authPath, JSON.stringify({ apiKey: "test-key" }), { mode: 0o600 }),
        );
        const whoamiStarted = yield* Deferred.make<void>();
        const billingStarted = yield* Deferred.make<void>();
        const client = HttpClient.make((request) =>
          request.url.includes("whoami")
            ? Deferred.succeed(whoamiStarted, undefined).pipe(
                Effect.andThen(Effect.sleep("5 seconds")),
                Effect.as(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
              )
            : request.url.includes("subscriptions")
              ? Deferred.succeed(billingStarted, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.sync(() => {
                  return HttpClientResponse.fromWeb(
                    request,
                    Response.json({ windowLimits: { weekly: { used: 7, cap: 35 } } }),
                  );
                }),
        );
        try {
          const pending = yield* readCommandCodeLimitSource({ authPath }).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.provide([NodeServices.layer, NodeCrypto.layer]),
            Effect.forkScoped,
          );
          yield* Deferred.await(whoamiStarted);
          yield* TestClock.adjust("5 seconds");
          yield* Deferred.await(billingStarted);
          yield* TestClock.adjust("8 seconds");
          const source = yield* Fiber.join(pending);
          assert.isNotNull(source);
          assert.deepStrictEqual(
            source.accounts[0]?.usageLimits.windows.map((w) => w.kind),
            ["weekly"],
          );
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
        }
      }),
  );
});
