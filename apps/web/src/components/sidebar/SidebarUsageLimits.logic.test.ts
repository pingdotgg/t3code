import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectSidebarLimits, limitTone } from "./SidebarUsageLimits.logic";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 85,
  windowDurationMins: 10_080,
  resetsAt: "2026-09-06T15:30:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function presentations(
  ...environments: ReadonlyArray<readonly [label: string, providers: readonly ServerProvider[]]>
) {
  return new Map(
    environments.map(([label, providers], index) => [
      EnvironmentId.make(`env-${index + 1}`),
      { entry: { target: { label } }, serverConfig: { providers } },
    ]),
  );
}

describe("limitTone", () => {
  it("steps from neutral to low to critical as the quota drains", () => {
    expect(limitTone(100)).toBe("ok");
    expect(limitTone(26)).toBe("ok");
    expect(limitTone(25)).toBe("low");
    expect(limitTone(11)).toBe("low");
    expect(limitTone(10)).toBe("critical");
    expect(limitTone(0)).toBe("critical");
  });
});

describe("collectSidebarLimits", () => {
  it("shows the tightest window per provider and keeps every window for the details", () => {
    const [codex] = collectSidebarLimits(
      presentations([
        "Laptop",
        [
          provider({
            usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [session, weekly] },
          }),
        ],
      ]),
      now,
    );
    expect(codex).toMatchObject({
      driver: "codex",
      accountCount: 1,
      remainingPercent: 15,
      tone: "low",
    });
    expect(codex?.windows).toEqual([
      {
        id: "session:five_hour",
        label: "Session",
        remainingPercent: 60,
        resetsAt: Date.parse(session.resetsAt),
      },
      {
        id: "weekly:seven_day",
        label: "Weekly",
        remainingPercent: 15,
        resetsAt: Date.parse(weekly.resetsAt),
      },
    ]);
  });

  it("pools accounts across environments and reports the soonest reset", () => {
    const views = collectSidebarLimits(
      presentations(
        [
          "Laptop",
          [
            provider({
              auth: { status: "authenticated", email: "a@example.com" },
              usageLimits: {
                checkedAt: "2026-09-03T11:00:00.000Z",
                windows: [{ ...session, usedPercent: 90, resetsAt: "2026-09-03T13:00:00.000Z" }],
              },
            }),
          ],
        ],
        [
          "Desktop",
          [
            provider({
              auth: { status: "authenticated", email: "b@example.com" },
              usageLimits: {
                checkedAt: "2026-09-03T11:00:00.000Z",
                windows: [{ ...session, usedPercent: 10 }],
              },
            }),
          ],
        ],
      ),
      now,
    );
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ accountCount: 2, remainingPercent: 50, tone: "ok" });
    expect(views[0]?.windows[0]?.resetsAt).toBe(Date.parse("2026-09-03T13:00:00.000Z"));
  });

  it("orders providers by driver and leaves out ones with nothing usable", () => {
    const views = collectSidebarLimits(
      presentations([
        "Laptop",
        [
          provider({
            usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [session] },
          }),
          provider({
            instanceId: ProviderInstanceId.make("claude"),
            driver: ProviderDriverKind.make("claudeAgent"),
            usageLimits: {
              checkedAt: "2026-09-03T11:00:00.000Z",
              windows: [{ ...weekly, usedPercent: 95 }],
            },
          }),
          provider({
            instanceId: ProviderInstanceId.make("claude-api"),
            driver: ProviderDriverKind.make("claudeAgent"),
            usageLimits: {
              checkedAt: "2026-09-03T11:00:00.000Z",
              windows: [],
              unavailable: { reason: "unsupported" },
            },
          }),
          provider({
            instanceId: ProviderInstanceId.make("cursor"),
            driver: ProviderDriverKind.make("cursor"),
          }),
        ],
      ]),
      now,
    );
    expect(views.map((view) => [view.driver, view.remainingPercent, view.tone])).toEqual([
      ["claudeAgent", 5, "critical"],
      ["codex", 60, "ok"],
    ]);
  });

  it("keeps a session and a monthly window apart when the provider reuses their id", () => {
    const [codex] = collectSidebarLimits(
      presentations(
        [
          "Laptop",
          [
            provider({
              auth: { status: "authenticated", email: "paid@example.com" },
              usageLimits: {
                checkedAt: "2026-09-03T11:00:00.000Z",
                windows: [{ ...session, id: "primary", usedPercent: 30 }],
              },
            }),
          ],
        ],
        [
          "Desktop",
          [
            provider({
              auth: { status: "authenticated", email: "free@example.com" },
              usageLimits: {
                checkedAt: "2026-09-03T11:00:00.000Z",
                windows: [{ id: "primary", kind: "monthly", label: "Monthly", usedPercent: 70 }],
              },
            }),
          ],
        ],
      ),
      now,
    );
    expect(codex?.windows.map((window) => [window.id, window.remainingPercent])).toEqual([
      ["session:primary", 70],
      ["monthly:primary", 30],
    ]);
  });

  it("is empty when no provider reports limits", () => {
    expect(collectSidebarLimits(presentations(["Laptop", [provider({})]]), now)).toEqual([]);
    expect(collectSidebarLimits(new Map(), now)).toEqual([]);
  });
});
