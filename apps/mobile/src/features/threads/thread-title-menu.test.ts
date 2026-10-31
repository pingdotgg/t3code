import { describe, expect, it } from "vite-plus/test";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { executeThreadUndo, planThreadUndo } from "@t3tools/client-runtime/state/thread-undo";
import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { makeRawThreadShell, makeThreadShellFixture } from "../../test-fixtures";
import {
  buildThreadTitleMenu,
  threadTitleMaxWidth,
  threadTitleMenuOffers,
  threadTitleMenuVersion,
  threadTitleSnoozeUntil,
} from "./thread-title-menu";

const now = new Date("2026-10-18T12:00:00.000Z");
const capabilities = {
  threadSettlement: true,
  threadSnooze: true,
  threadPinning: true,
  threadTitleRegeneration: true,
};
const thread = makeThreadShellFixture();
const menu = (overrides: Partial<Parameters<typeof buildThreadTitleMenu>[0]> = {}) =>
  buildThreadTitleMenu({
    thread,
    capabilities,
    canOperate: true,
    hasQueuedMessages: false,
    now,
    ...overrides,
  });
const ids = (overrides: Partial<Parameters<typeof buildThreadTitleMenu>[0]> = {}) =>
  menu(overrides).map((action) => action.id);

describe("thread title actions", () => {
  it("preserves the displayed snooze instant when selection crosses midnight", () => {
    const beforeMidnight = new Date("2026-10-18T23:59:00.000Z");
    const actions = menu({ now: beforeMidnight });
    const preset = actions
      .find((action) => action.id === "snooze")
      ?.subactions?.find((action) => action.id !== "snooze:custom");
    expect(preset?.id).toBeDefined();
    const until = preset!.id!.slice("snooze:".length);
    expect(threadTitleSnoozeUntil(preset!.id!, new Date(beforeMidnight.getTime() + 120_000))).toBe(
      until,
    );
    expect(threadTitleSnoozeUntil(preset!.id!, new Date(Date.parse(until) + 1))).toBeNull();
  });
  it("keeps a read-only connection from offering mutations", () => {
    expect(ids({ canOperate: false })).toEqual(["copy-thread-id"]);
  });
  it("omits unsupported lifecycle and title regeneration commands on older servers", () => {
    expect(ids({ capabilities: undefined })).toEqual(["rename", "copy-thread-id", "delete"]);
  });
  it("offers reverse actions after settling, pinning and snoozing", () => {
    const result = ids({
      thread: {
        ...thread,
        settledOverride: "settled",
        pinnedAt: now.toISOString(),
        snoozedAt: now.toISOString(),
        snoozedUntil: "2026-10-19T12:00:00.000Z",
      },
    });
    expect(result).toContain("unsettle");
    expect(result).toContain("unpin");
    expect(result).toContain("unsnooze");
    expect(result).not.toContain("settle");
    expect(result).not.toContain("pin");
    expect(result).not.toContain("snooze");
  });
  it("treats a locally queued message as active even before its settled shell updates", () => {
    expect(
      ids({ thread: { ...thread, settledOverride: "settled" }, hasQueuedMessages: true }),
    ).toContain("settle");
    expect(
      ids({ thread: { ...thread, settledOverride: "settled" }, hasQueuedMessages: true }),
    ).not.toContain("unsettle");
  });
  it("offers Un-settle for a settled timestamp without an override, as the server treats it", () => {
    const settled = presentThreadShell(
      EnvironmentId.make("environment-test"),
      makeRawThreadShell({
        settledOverride: null,
        settledAt: DateTime.makeUnsafe("2026-10-18T11:00:00.000Z"),
      }),
    );
    expect(ids({ thread: settled })).toContain("unsettle");
    expect(ids({ thread: settled })).not.toContain("settle");
    expect(ids({ thread: settled, hasQueuedMessages: true })).toContain("settle");
    expect(ids({ thread: settled, hasQueuedMessages: true })).not.toContain("unsettle");
  });
  it("cannot snooze a thread waiting for a response", () => {
    expect(ids({ thread: { ...thread, hasPendingApprovals: true } })).not.toContain("snooze");
    expect(ids({ thread: { ...thread, hasPendingUserInput: true } })).not.toContain("snooze");
  });
  it("returns snooze after expiry and provides future presets", () => {
    const actions = menu({ thread: { ...thread, snoozedUntil: "2026-10-17T12:00:00.000Z" } });
    expect(actions.some((action) => action.id === "unsnooze")).toBe(false);
    const snooze = actions.find((action) => action.id === "snooze");
    expect(snooze?.subactions?.length).toBeGreaterThan(1);
    expect(snooze?.subactions?.at(-1)?.id).toBe("snooze:custom");
    const customized = menu({ snoozePresets: [{ kind: "after", minutes: 360 }] });
    expect(
      customized.find((action) => action.id === "snooze")?.subactions?.map((action) => action.id),
    ).toEqual([`snooze:${new Date(now.getTime() + 360 * 60_000).toISOString()}`, "snooze:custom"]);
  });
  it("disables title regeneration while it is running and retains destructive confirmation semantics", () => {
    const actions = menu({
      thread: {
        ...thread,
        titleRegeneration: { requestId: "request-1", startedAt: now.toISOString() },
      },
    });
    expect(actions.find((action) => action.id === "regenerate-title")?.attributes?.disabled).toBe(
      true,
    );
    expect(actions.find((action) => action.id === "delete")?.attributes?.destructive).toBe(true);
  });
});

describe("thread title menu events", () => {
  const snoozeId = menu()
    .find((action) => action.id === "snooze")
    ?.subactions?.find((action) => action.id !== "snooze:custom")?.id;
  it.each(["settle", snoozeId!, "snooze:custom", "pin", "rename", "regenerate-title", "delete"])(
    "drops a stale %s chosen before mutations became unavailable",
    (event) => {
      expect(threadTitleMenuOffers(menu(), event)).toBe(true);
      expect(threadTitleMenuOffers(menu({ canOperate: false }), event)).toBe(false);
    },
  );
  it("keeps Copy thread ID while mutations are unavailable", () => {
    expect(threadTitleMenuOffers(menu({ canOperate: false }), "copy-thread-id")).toBe(true);
  });
});

describe("thread title header content", () => {
  it("re-renders native title content only when the menu or title can change", () => {
    const version = threadTitleMenuVersion(thread);
    expect(
      threadTitleMenuVersion({ ...thread, updatedAt: "2026-10-18T12:00:01.000Z", itemCount: 9 }),
    ).toEqual(version);
    expect(threadTitleMenuVersion({ ...thread, title: "Renamed" })).not.toEqual(version);
    expect(threadTitleMenuVersion({ ...thread, settledOverride: "settled" })).not.toEqual(version);
  });

  it("re-renders when another client reorders a pinned thread, so Undo restores the new order", async () => {
    const pinned = makeThreadShellFixture({
      pinnedAt: "2026-10-18T11:00:00.000Z",
      pinOrderKey: "a0",
    });
    const reordered = { ...pinned, pinOrderKey: "a2", updatedAt: "2026-10-18T12:00:01.000Z" };
    // The native header keeps its title element, and that element's shell, until the version changes.
    const titleShell =
      JSON.stringify(threadTitleMenuVersion(reordered)) ===
      JSON.stringify(threadTitleMenuVersion(pinned))
        ? pinned
        : reordered;

    const restoredOrderKeys: Array<string | undefined> = [];
    await executeThreadUndo(
      planThreadUndo("unpin", titleShell),
      async (step) => {
        if (step.action === "pin") restoredOrderKeys.push(step.orderKey);
        return true;
      },
      (succeeded) => succeeded,
    );
    expect(restoredOrderKeys).toEqual(["a2"]);
  });

  it("re-renders when only the settled timestamp arrives or clears", () => {
    const shell = (settledAt: OrchestrationV2ThreadShell["settledAt"]) =>
      presentThreadShell(
        EnvironmentId.make("environment-test"),
        makeRawThreadShell({ settledOverride: null, settledAt }),
      );
    const active = shell(null);
    const settled = shell(DateTime.makeUnsafe("2026-10-18T11:00:00.000Z"));
    expect(settled.settledOverride).toBe(active.settledOverride);
    expect(threadTitleMenuVersion(settled)).not.toEqual(threadTitleMenuVersion(active));
    expect(threadTitleMenuVersion(shell(null))).toEqual(threadTitleMenuVersion(active));
  });

  it("re-renders when a nonblocking question arrives or clears during a run", () => {
    const runId = RunId.make("run-1");
    const running = (pendingRuntimeRequest: OrchestrationV2ThreadShell["pendingRuntimeRequest"]) =>
      presentThreadShell(
        EnvironmentId.make("environment-test"),
        makeRawThreadShell({
          status: "running",
          latestRunId: runId,
          activeRunId: runId,
          pendingRuntimeRequest,
        }),
      );
    const idle = running(null);
    const asking = running({
      id: RuntimeRequestId.make("request-1"),
      kind: "user_input",
      createdAt: DateTime.makeUnsafe("2026-10-18T12:00:00.000Z"),
      blocking: false,
    });
    for (const shell of [idle, asking]) {
      expect(shell.hasPendingApprovals).toBe(false);
      expect(shell.hasPendingUserInput).toBe(false);
    }
    expect(ids({ thread: idle })).toContain("snooze");
    expect(ids({ thread: asking })).not.toContain("snooze");
    expect(threadTitleMenuVersion(asking)).not.toEqual(threadTitleMenuVersion(idle));
    expect(threadTitleMenuVersion({ ...asking, itemCount: 9 })).toEqual(
      threadTitleMenuVersion(asking),
    );
  });

  it("refreshes snooze availability when a guest message arrives or clears", () => {
    const idle = { ...thread, pendingGuestMessageCount: 0 };
    const waiting = { ...thread, pendingGuestMessageCount: 1 };
    expect(ids({ thread: idle })).toContain("snooze");
    expect(ids({ thread: waiting })).not.toContain("snooze");
    expect(threadTitleMenuVersion(waiting)).not.toEqual(threadTitleMenuVersion(idle));
    expect(threadTitleMenuVersion({ ...waiting, pendingGuestMessageCount: 0 })).toEqual(
      threadTitleMenuVersion(idle),
    );
  });

  const gitItems = [
    { type: "button", icon: { name: "branch" } },
    { type: "spacing", spacing: 8 },
    { type: "button", icon: { name: "terminal" } },
  ];
  const width = (overrides: Partial<Parameters<typeof threadTitleMaxWidth>[0]>) =>
    threadTitleMaxWidth({
      paneWidth: 320,
      horizontalInsets: 0,
      verticalBar: false,
      leadingItems: null,
      trailingItems: gitItems,
      compose: false,
      ...overrides,
    });

  it("leaves the title most of a compact Duo bar when actions move to the vertical bar", () => {
    expect(width({ verticalBar: true, compose: true })).toBeGreaterThanOrEqual(200);
    expect(width({ compose: true })).toBeLessThan(width({ compose: false }));
  });

  it("keeps a usable title target in a minimum-width split pane", () => {
    expect(
      width({
        leadingItems: [
          { type: "button", icon: { name: "sidebar.left" }, axisBehavior: "horizontalOnly" },
          { type: "button", icon: { name: "square.and.pencil" } },
        ],
      }),
    ).toBe(44);
  });
});
