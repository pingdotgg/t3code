import { describe, expect, it } from "@effect/vitest";

import type { RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  DEFAULT_THREAD_STALL_AFTER_MS,
  isThreadStalled,
  threadAwaitsOwnerAttention,
  threadHasAgentOpenWork,
} from "./threadStall.ts";

const NOW_MS = Date.parse("2026-05-22T12:00:00.000Z");
const FRESH_MS = NOW_MS - 5 * 60_000;
const STALE_MS = NOW_MS - DEFAULT_THREAD_STALL_AFTER_MS - 1_000;

const base = (
  overrides: Partial<Parameters<typeof isThreadStalled>[0]> = {},
): Parameters<typeof isThreadStalled>[0] => ({
  activityRunStatus: "running",
  archivedAt: null,
  blockedOnThreadWait: false,
  deletedAt: null,
  latestRunBackgroundWake: false,
  pendingBackgroundTasks: [],
  pendingGuestMessageCount: 0,
  pendingRuntimeRequest: null,
  settledOverride: null,
  snoozedUntil: null,
  status: "running",
  updatedAt: DateTime.makeUnsafe(STALE_MS),
  ...overrides,
});

describe("threadHasAgentOpenWork", () => {
  it.each([
    ["activity run", { activityRunStatus: "waiting" as const, status: "completed" as const }, true],
    ["live status", { activityRunStatus: null, status: "starting" as const }, true],
    [
      "awaited subagent",
      {
        activityRunStatus: null,
        status: "completed" as const,
        pendingBackgroundTasks: [{ taskId: "review", kind: "subagent" as const }],
      },
      true,
    ],
    [
      "monitor wake",
      {
        activityRunStatus: null,
        status: "completed" as const,
        latestRunBackgroundWake: true,
        pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" as const }],
      },
      true,
    ],
    ["idle complete", { activityRunStatus: null, status: "completed" as const }, false],
    [
      "unawaited command",
      {
        activityRunStatus: null,
        status: "completed" as const,
        pendingBackgroundTasks: [{ taskId: "dev", kind: "command" as const }],
      },
      false,
    ],
  ] as const)("%s", (_label, overrides, expected) => {
    expect(threadHasAgentOpenWork(base(overrides))).toBe(expected);
  });
});

describe("threadAwaitsOwnerAttention", () => {
  it("treats approvals, questions, and guest messages as owner waits", () => {
    expect(threadAwaitsOwnerAttention(base())).toBe(false);
    expect(
      threadAwaitsOwnerAttention(
        base({
          pendingRuntimeRequest: {
            id: "request-1" as RuntimeRequestId,
            kind: "command",
            createdAt: DateTime.makeUnsafe(NOW_MS),
          },
        }),
      ),
    ).toBe(true);
    expect(
      threadAwaitsOwnerAttention(
        base({
          pendingRuntimeRequest: {
            id: "request-2" as RuntimeRequestId,
            kind: "user_input",
            createdAt: DateTime.makeUnsafe(NOW_MS),
          },
        }),
      ),
    ).toBe(true);
    expect(threadAwaitsOwnerAttention(base({ pendingGuestMessageCount: 1 }))).toBe(true);
    expect(
      threadAwaitsOwnerAttention(
        base({
          pendingRuntimeRequest: {
            id: "request-auth" as RuntimeRequestId,
            kind: "auth_refresh",
            createdAt: DateTime.makeUnsafe(NOW_MS),
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("isThreadStalled", () => {
  it("flags quiet open agent work past the stall age", () => {
    expect(isThreadStalled(base(), NOW_MS)).toBe(true);
    expect(isThreadStalled(base({ updatedAt: DateTime.makeUnsafe(FRESH_MS) }), NOW_MS)).toBe(false);
  });

  it("skips owner waits, intentional thread waits, settled, snoozed, and archived", () => {
    const stalled = base();
    expect(isThreadStalled(stalled, NOW_MS)).toBe(true);
    expect(
      isThreadStalled(
        base({
          pendingRuntimeRequest: {
            id: "request-1" as RuntimeRequestId,
            kind: "user_input",
            createdAt: DateTime.makeUnsafe(STALE_MS),
          },
        }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(isThreadStalled(base({ blockedOnThreadWait: true }), NOW_MS)).toBe(false);
    expect(isThreadStalled(base({ settledOverride: "settled" }), NOW_MS)).toBe(false);
    expect(
      isThreadStalled(base({ snoozedUntil: DateTime.makeUnsafe(NOW_MS + 60_000) }), NOW_MS),
    ).toBe(false);
    expect(isThreadStalled(base({ archivedAt: DateTime.makeUnsafe(STALE_MS) }), NOW_MS)).toBe(
      false,
    );
    expect(isThreadStalled(base({ activityRunStatus: null, status: "completed" }), NOW_MS)).toBe(
      false,
    );
  });

  it("flags a completed shell held open by quiet background work", () => {
    expect(
      isThreadStalled(
        base({
          activityRunStatus: null,
          status: "completed",
          pendingBackgroundTasks: [{ taskId: "review", kind: "subagent" }],
        }),
        NOW_MS,
      ),
    ).toBe(true);
  });
});
