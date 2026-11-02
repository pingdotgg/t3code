// @effect-diagnostics globalDate:off -- compare fixture epoch ms against standard ISO.
// @effect-diagnostics nodeBuiltinImport:off -- isolated fake auth file for HTTP tests.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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
  it("reports subscription monthly credits separately from purchased credits", () => {
    assert.deepStrictEqual(
      commandCodeMonthlyWindow(
        { credits: { monthlyCredits: 20, monthlyCreditsTotal: 30, purchasedCredits: 100 } },
        {
          data: {
            status: "active",
            planId: "individual-pro",
            currentPeriodEnd: "2026-12-01T00:00:00.000Z",
          },
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
  it("does not guess monthly credits for unknown, inactive or malformed plans", () => {
    const credits = { credits: { monthlyCredits: 20, monthlyCreditsTotal: 30 } };
    const active = {
      status: "active",
      planId: "individual-pro",
      currentPeriodEnd: "2026-12-01T00:00:00.000Z",
    };
    for (const data of [
      { ...active, status: "cancelled" },
      { ...active, currentPeriodEnd: null },
    ])
      assert.isNull(commandCodeMonthlyWindow(credits, { data }));
    assert.isNull(
      commandCodeMonthlyWindow(
        { credits: { monthlyCredits: 31, monthlyCreditsTotal: 30 } },
        { data: active },
      ),
    );
    // Plan IDs and published advertised values cannot substitute for an API-reported allowance.
    assert.isNull(commandCodeMonthlyWindow({ credits: { monthlyCredits: 20 } }, { data: active }));
    assert.isNull(
      commandCodeMonthlyWindow(
        { credits: { monthlyCredits: 20, monthlyCreditsTotal: 0 } },
        { data: active },
      ),
    );
    assert.isNull(commandCodeMonthlyWindow({}, { data: active }));
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
                  currentPeriodEnd: "2026-12-01T00:00:00.000Z",
                },
              }),
            );
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              credits: { monthlyCredits: 15, monthlyCreditsTotal: 30 },
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
        );
        assert.isNotNull(source);
        assert.strictEqual(source.kind, "cliproxy");
        assert.strictEqual(source.accounts[0]?.driver, "command-code");
        assert.isFalse("error" in source);
        assert.deepStrictEqual(
          source.accounts[0]?.usageLimits.windows.map((w) => w.usedPercent),
          [(3 / 14) * 100, 20, 50],
        );
        assert.deepStrictEqual(visited, [
          "https://api.commandcode.ai/alpha/whoami?limits=1",
          "https://api.commandcode.ai/alpha/billing/credits?orgId=org-for-test",
          "https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-for-test",
        ]);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
  );

  it.effect("keeps rolling windows if the subscription endpoint fails", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cmd-limits-")),
      );
      const authPath = NodePath.join(dir, "auth.json");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(authPath, JSON.stringify({ apiKey: "test-key" }), { mode: 0o600 }),
      );
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.url.includes("whoami"))
            return HttpClientResponse.fromWeb(request, Response.json({ success: true }));
          if (request.url.includes("subscriptions"))
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ windowLimits: { weekly: { used: 7, cap: 35 } } }),
          );
        }),
      );
      try {
        const source = yield* readCommandCodeLimitSource({ authPath }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
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
