import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderQuotaSnapshot,
  type ProviderQuotaSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { OrderedProviderSettingsRow } from "../settings/ProviderSettingsPanel.logic";
import {
  buildProviderUsageStripItems,
  cancelProviderResetAttempt,
  confirmProviderResetAttempt,
  createProviderResetAttemptState,
  settleProviderResetAttempt,
} from "./ProviderUsageStrip.logic";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

function row(input: {
  readonly id: string;
  readonly driver?: ProviderDriverKind;
  readonly enabled?: boolean;
  readonly displayName?: string;
}): OrderedProviderSettingsRow {
  const driver = input.driver ?? codex;
  return {
    instanceId: ProviderInstanceId.make(input.id),
    instance: {
      driver,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    },
    driver,
    isDefault: input.id === driver,
  };
}

function snapshot(input: {
  readonly id: string;
  readonly driver?: ProviderDriverKind;
  readonly status?: ProviderQuotaSnapshot["status"];
  readonly remaining?: number | null;
  readonly blocking?: boolean;
  readonly headlineMetricKey?: string | null;
}): ProviderQuotaSnapshot {
  const key = "weekly";
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driver: input.driver ?? codex,
    status: input.status ?? "current",
    source: "provider",
    readAt: "2026-08-11T08:00:00.000Z",
    lastSuccessfulReadAt: "2026-08-11T08:00:00.000Z",
    headlineMetricKey: input.headlineMetricKey === undefined ? key : input.headlineMetricKey,
    metrics: [
      {
        key,
        label: "Weekly limit",
        remainingPercent: input.remaining === undefined ? 72.4 : input.remaining,
        usedPercent: 27.6,
        resetsAt: "2026-08-17T00:00:00.000Z",
        windowMinutes: 10_080,
        blocking: input.blocking ?? true,
      },
    ],
    credits: null,
    bankedResets: null,
    detail: {},
    message: null,
  };
}

function summary(instances: ReadonlyArray<ProviderQuotaSnapshot>): ProviderQuotaSummary {
  return { readAt: "2026-08-11T08:00:00.000Z", instances };
}

describe("buildProviderUsageStripItems", () => {
  it("preserves Settings order after filtering effectively disabled rows", () => {
    const items = buildProviderUsageStripItems({
      rows: [
        row({ id: "claude", driver: claude }),
        row({ id: "codex-disabled", enabled: false }),
        row({ id: "codex-work", displayName: "Work Codex" }),
      ],
      summary: summary([
        snapshot({ id: "codex-work" }),
        snapshot({ id: "claude", driver: claude }),
      ]),
    });

    expect(items.map((item) => item.instanceId)).toEqual(["claude", "codex-work"]);
    expect(items.map((item) => item.displayName)).toEqual(["Claude", "Work Codex"]);
  });

  it("joins by instance ID and keeps repeated same-driver accounts distinct", () => {
    const items = buildProviderUsageStripItems({
      rows: [row({ id: "codex-personal" }), row({ id: "codex-work" })],
      summary: summary([
        snapshot({ id: "codex-work", remaining: 12.2 }),
        snapshot({ id: "codex-personal", remaining: 88.8 }),
      ]),
    });

    expect(items.map((item) => [item.instanceId, item.driver, item.percentage])).toEqual([
      ["codex-personal", "codex", 89],
      ["codex-work", "codex", 12],
    ]);
  });

  it.each([
    [-8, 0],
    [49.5, 50],
    [132, 100],
  ])("clamps and rounds a current blocking headline of %s to %s", (remaining, expected) => {
    const [item] = buildProviderUsageStripItems({
      rows: [row({ id: "codex" })],
      summary: summary([snapshot({ id: "codex", remaining })]),
    });

    expect(item?.percentage).toBe(expected);
    expect(item?.headlineLabel).toBe("Weekly limit");
  });

  it.each(["stale", "authRequired", "error", "unknown"] as const)(
    "uses a dash for a %s snapshot",
    (status) => {
      const [item] = buildProviderUsageStripItems({
        rows: [row({ id: "codex" })],
        summary: summary([snapshot({ id: "codex", status })]),
      });
      expect(item?.percentage).toBeNull();
      expect(item?.headlineLabel).toBeNull();
    },
  );

  it("uses a dash for non-blocking, unknown, or old-server data without hiding the row", () => {
    const cases = [
      summary([snapshot({ id: "codex", blocking: false })]),
      summary([snapshot({ id: "codex", headlineMetricKey: "missing" })]),
      null,
    ];

    expect(
      cases.map((quotaSummary) => {
        const items = buildProviderUsageStripItems({
          rows: [row({ id: "codex" })],
          summary: quotaSummary,
        });
        return [items.length, items[0]?.percentage];
      }),
    ).toEqual([
      [1, null],
      [1, null],
      [1, null],
    ]);
  });
});

describe("provider reset attempt", () => {
  it("creates one key on confirmation and retains it after a transport failure", () => {
    const created: string[] = [];
    const confirmed = confirmProviderResetAttempt(createProviderResetAttemptState(), () => {
      const key = `attempt-${created.length + 1}`;
      created.push(key);
      return key;
    });
    const failed = settleProviderResetAttempt(confirmed, {
      kind: "transportError",
      message: "Offline",
    });
    const retried = confirmProviderResetAttempt(failed, () => "unexpected-second-key");

    expect(created).toEqual(["attempt-1"]);
    expect(retried).toMatchObject({ idempotencyKey: "attempt-1", pending: true });
  });

  it.each(["reset", "nothingToReset", "noCredit", "alreadyRedeemed"] as const)(
    "clears the key and provides explicit feedback for %s",
    (outcome) => {
      const pending = confirmProviderResetAttempt(createProviderResetAttemptState(), () => "key");
      const settled = settleProviderResetAttempt(pending, { kind: "outcome", outcome });

      expect(settled.idempotencyKey).toBeNull();
      expect(settled.pending).toBe(false);
      expect(settled.feedback).not.toBeNull();
    },
  );

  it("clears a retained attempt when confirmation is cancelled", () => {
    const pending = confirmProviderResetAttempt(createProviderResetAttemptState(), () => "key");
    expect(cancelProviderResetAttempt(pending)).toEqual(createProviderResetAttemptState());
  });
});
