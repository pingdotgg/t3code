import { describe, expect, it } from "vite-plus/test";

import {
  applySettlementFieldsToThread,
  reduceThreadSettlementEvent,
  settledOverrideTimestampMs,
  shouldApplyActivityUnsettle,
  type SettledThreadFields,
} from "./orchestrationV2Settled.ts";

const T0 = Date.parse("2026-07-01T10:00:00.000Z");
const T1 = Date.parse("2026-07-01T11:00:00.000Z");
const T2 = Date.parse("2026-07-01T12:00:00.000Z");

type ThreadFixture = SettledThreadFields & { readonly title: string };

describe("shouldApplyActivityUnsettle", () => {
  it("never clears when there is no override", () => {
    expect(
      shouldApplyActivityUnsettle(
        { settledOverride: null, settledAtMs: null, settledOverrideAtMs: null, updatedAtMs: T1 },
        T2,
      ),
    ).toBe(false);
  });

  it("blocks delayed activity older than a settled pin", () => {
    expect(
      shouldApplyActivityUnsettle(
        { settledOverride: "settled", settledAtMs: T2, settledOverrideAtMs: null, updatedAtMs: T2 },
        T1,
      ),
    ).toBe(false);
    expect(
      shouldApplyActivityUnsettle(
        { settledOverride: "settled", settledAtMs: T1, settledOverrideAtMs: null, updatedAtMs: T1 },
        T1,
      ),
    ).toBe(true);
    expect(
      shouldApplyActivityUnsettle(
        { settledOverride: "settled", settledAtMs: T1, settledOverrideAtMs: null, updatedAtMs: T1 },
        T2,
      ),
    ).toBe(true);
  });

  it("blocks delayed activity older than an active pin (updatedAt)", () => {
    expect(
      shouldApplyActivityUnsettle(
        {
          settledOverride: "active",
          settledAtMs: null,
          settledOverrideAtMs: null,
          updatedAtMs: T2,
        },
        T1,
      ),
    ).toBe(false);
    expect(
      shouldApplyActivityUnsettle(
        {
          settledOverride: "active",
          settledAtMs: null,
          settledOverrideAtMs: null,
          updatedAtMs: T1,
        },
        T2,
      ),
    ).toBe(true);
  });
});

describe("settledOverrideTimestampMs", () => {
  it("uses settledAt for settled and updatedAt for active without overrideAt", () => {
    expect(
      settledOverrideTimestampMs({
        settledOverride: "settled",
        settledAtMs: T1,
        settledOverrideAtMs: null,
        updatedAtMs: T2,
      }),
    ).toBe(T1);
    expect(
      settledOverrideTimestampMs({
        settledOverride: "active",
        settledAtMs: null,
        settledOverrideAtMs: null,
        updatedAtMs: T2,
      }),
    ).toBe(T2);
    expect(
      settledOverrideTimestampMs({
        settledOverride: null,
        settledAtMs: null,
        settledOverrideAtMs: null,
        updatedAtMs: T2,
      }),
    ).toBeNull();
  });

  it("prefers settledOverrideAt over settledAt and updatedAt", () => {
    expect(
      settledOverrideTimestampMs({
        settledOverride: "settled",
        settledAtMs: T1,
        settledOverrideAtMs: T0,
        updatedAtMs: T2,
      }),
    ).toBe(T0);
    expect(
      settledOverrideTimestampMs({
        settledOverride: "active",
        settledAtMs: null,
        settledOverrideAtMs: T1,
        updatedAtMs: T2,
      }),
    ).toBe(T1);
  });
});

describe("applySettlementFieldsToThread", () => {
  it("preserves non-settlement fields from the current thread", () => {
    const current: ThreadFixture & { archivedAt: string } = {
      title: "Current title",
      archivedAt: "2026-07-01T09:00:00.000Z",
      settledOverride: "settled",
      settledAt: "2026-07-01T10:00:00.000Z",
      settledOverrideAt: null,
      updatedAt: "2026-07-01T10:00:00.000Z",
    };
    const next = applySettlementFieldsToThread(current, {
      settledOverride: null,
      settledAt: null,
      settledOverrideAt: null,
      updatedAt: "2026-07-01T11:00:00.000Z",
    });
    expect(next).toEqual({
      title: "Current title",
      archivedAt: "2026-07-01T09:00:00.000Z",
      settledOverride: null,
      settledAt: null,
      settledOverrideAt: null,
      updatedAt: "2026-07-01T11:00:00.000Z",
    });
  });
});

describe("reduceThreadSettlementEvent", () => {
  const base: ThreadFixture = {
    title: "Live title",
    settledOverride: "settled",
    settledAt: "2026-07-01T12:00:00.000Z",
    settledOverrideAt: null,
    updatedAt: "2026-07-01T12:00:00.000Z",
  };

  it("ignores delayed activity unsettles against a newer settled pin", () => {
    const next = reduceThreadSettlementEvent({
      current: base,
      eventType: "thread.unsettled",
      settlement: {
        settledOverride: null,
        settledAt: null,
        settledOverrideAt: null,
        updatedAt: "2026-07-01T11:00:00.000Z",
      },
      activityAtMs: T1,
      currentTimestamps: {
        settledOverride: "settled",
        settledAtMs: T2,
        settledOverrideAtMs: null,
        updatedAtMs: T2,
      },
    });
    expect(next).toBe(base);
  });

  it("ignores delayed activity unsettles against a newer active pin", () => {
    const active: ThreadFixture = {
      title: "Live title",
      settledOverride: "active",
      settledAt: null,
      settledOverrideAt: null,
      updatedAt: "2026-07-01T12:00:00.000Z",
    };
    const next = reduceThreadSettlementEvent({
      current: active,
      eventType: "thread.unsettled",
      settlement: {
        settledOverride: null,
        settledAt: null,
        settledOverrideAt: null,
        updatedAt: "2026-07-01T11:00:00.000Z",
      },
      activityAtMs: T1,
      currentTimestamps: {
        settledOverride: "active",
        settledAtMs: null,
        settledOverrideAtMs: null,
        updatedAtMs: T2,
      },
    });
    expect(next).toBe(active);
  });

  it("applies activity unsettle when activity is at or after the pin", () => {
    const next = reduceThreadSettlementEvent({
      current: base,
      eventType: "thread.unsettled",
      settlement: {
        settledOverride: null,
        settledAt: null,
        settledOverrideAt: null,
        updatedAt: "2026-07-01T12:00:00.000Z",
      },
      activityAtMs: T2,
      currentTimestamps: {
        settledOverride: "settled",
        settledAtMs: T2,
        settledOverrideAtMs: null,
        updatedAtMs: T2,
      },
    });
    expect(next.settledOverride).toBeNull();
    expect(next.title).toBe("Live title");
  });

  it("always applies an explicit settle", () => {
    const neutral: ThreadFixture = {
      title: "Live title",
      settledOverride: null,
      settledAt: null,
      settledOverrideAt: null,
      updatedAt: "2026-07-01T10:00:00.000Z",
    };
    const next = reduceThreadSettlementEvent({
      current: neutral,
      eventType: "thread.settled",
      settlement: {
        settledOverride: "settled",
        settledAt: "2026-07-01T12:00:00.000Z",
        settledOverrideAt: null,
        updatedAt: "2026-07-01T12:00:00.000Z",
      },
      activityAtMs: T0,
      currentTimestamps: {
        settledOverride: null,
        settledAtMs: null,
        settledOverrideAtMs: null,
        updatedAtMs: T0,
      },
    });
    expect(next.settledOverride).toBe("settled");
  });

  it("always applies a user keep-active pin", () => {
    const next = reduceThreadSettlementEvent({
      current: base,
      eventType: "thread.unsettled",
      settlement: {
        settledOverride: "active",
        settledAt: null,
        settledOverrideAt: null,
        updatedAt: "2026-07-01T12:30:00.000Z",
      },
      activityAtMs: T0,
      currentTimestamps: {
        settledOverride: "settled",
        settledAtMs: T2,
        settledOverrideAtMs: null,
        updatedAtMs: T2,
      },
    });
    expect(next.settledOverride).toBe("active");
    expect(next.settledAt).toBeNull();
  });

  it("clears pinnedAt on explicit settle when the patch carries it", () => {
    const pinned: ThreadFixture & { pinnedAt: string | null } = {
      ...base,
      settledOverride: null,
      settledAt: null,
      settledOverrideAt: null,
      pinnedAt: "2026-07-01T11:00:00.000Z",
    };
    const next = reduceThreadSettlementEvent({
      current: pinned,
      eventType: "thread.settled",
      settlement: {
        settledOverride: "settled",
        settledAt: "2026-07-01T12:00:00.000Z",
        settledOverrideAt: null,
        updatedAt: "2026-07-01T12:00:00.000Z",
        pinnedAt: null,
      },
      activityAtMs: T2,
      currentTimestamps: {
        settledOverride: null,
        settledAtMs: null,
        settledOverrideAtMs: null,
        updatedAtMs: T1,
      },
    });
    expect(next.settledOverride).toBe("settled");
    expect(next.pinnedAt).toBeNull();
  });

  it("does not touch pinnedAt on activity unsettle", () => {
    const pinned = {
      ...base,
      pinnedAt: "2026-07-01T11:00:00.000Z",
    };
    const next = reduceThreadSettlementEvent({
      current: pinned,
      eventType: "thread.unsettled",
      settlement: {
        settledOverride: null,
        settledAt: null,
        settledOverrideAt: null,
        updatedAt: "2026-07-01T12:00:00.000Z",
      },
      activityAtMs: T2,
      currentTimestamps: {
        settledOverride: "settled",
        settledAtMs: T2,
        settledOverrideAtMs: null,
        updatedAtMs: T2,
      },
    });
    expect(next.settledOverride).toBeNull();
    expect(next.pinnedAt).toBe("2026-07-01T11:00:00.000Z");
  });

  it("does not rewind updatedAt when activity is older than current metadata", () => {
    const renamed: ThreadFixture = {
      ...base,
      settledOverride: "settled",
      settledAt: "2026-07-01T11:00:00.000Z",
      settledOverrideAt: null,
      updatedAt: "2026-07-01T13:00:00.000Z",
    };
    const T3 = Date.parse("2026-07-01T13:00:00.000Z");
    const next = reduceThreadSettlementEvent({
      current: renamed,
      eventType: "thread.unsettled",
      settlement: {
        settledOverride: null,
        settledAt: null,
        settledOverrideAt: null,
        updatedAt: "2026-07-01T12:00:00.000Z",
      },
      activityAtMs: T2,
      currentTimestamps: {
        settledOverride: "settled",
        settledAtMs: T1,
        settledOverrideAtMs: null,
        updatedAtMs: T3,
      },
    });
    expect(next.settledOverride).toBeNull();
    expect(next.updatedAt).toBe("2026-07-01T13:00:00.000Z");
  });

  it("clears a keep-active pin after rename when settledOverrideAt is stable", () => {
    // Keep-active at T1, metadata rename advances updatedAt to T3, delayed
    // activity at T2 still clears because override establishment is T1.
    const T3 = Date.parse("2026-07-01T13:00:00.000Z");
    const active: ThreadFixture = {
      title: "Renamed title",
      settledOverride: "active",
      settledAt: null,
      settledOverrideAt: "2026-07-01T11:00:00.000Z",
      updatedAt: "2026-07-01T13:00:00.000Z",
    };
    const next = reduceThreadSettlementEvent({
      current: active,
      eventType: "thread.unsettled",
      settlement: {
        settledOverride: null,
        settledAt: null,
        settledOverrideAt: null,
        updatedAt: "2026-07-01T12:00:00.000Z",
      },
      activityAtMs: T2,
      currentTimestamps: {
        settledOverride: "active",
        settledAtMs: null,
        settledOverrideAtMs: T1,
        updatedAtMs: T3,
      },
    });
    expect(next.settledOverride).toBeNull();
    expect(next.settledOverrideAt).toBeNull();
    expect(next.updatedAt).toBe("2026-07-01T13:00:00.000Z");
  });
});
