import { makeThreadShellFixture } from "../../test-fixtures";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connectedEnvironmentIds: [] as EnvironmentId[],
  pendingOrder: null as object | null,
  dropBusy: false,
  failedAction: null as string | null,
  failureMessage: "Server rejected action",
  forgotten: [] as { environmentId: string; threadId: string }[],
  archivedRefreshes: [] as string[],
  scopes: new Map<string, Set<string>>(),
  shells: [] as EnvironmentThreadShell[],
  requests: [] as {
    action: string;
    environmentId: string;
    input: { threadId: string; orderKey?: string; snoozedUntil?: string; reason?: string };
  }[],
  dialogs: [] as { onConfirm: () => void }[],
  alerts: [] as {
    title: string;
    message: string;
    buttons?: { text: string; onPress?: () => void }[];
  }[],
  afterRequest: undefined as (() => void) | undefined,
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, message: string, buttons?: { text: string; onPress?: () => void }[]) =>
      state.alerts.push({ title, message, buttons }),
  },
}));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (title: string, message: string, buttons?: { text: string; onPress?: () => void }[]) =>
    state.alerts.push({ title, message, buttons }),
  confirm: (dialog: { onConfirm: () => void }) => state.dialogs.push(dialog),
}));
vi.mock("../archive/useArchivedThreadSnapshots", () => ({
  refreshArchivedThreadsForEnvironment: (environmentId: string) => {
    state.archivedRefreshes.push(environmentId);
  },
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../../state/forgotten-threads", () => ({
  forgetThread: (environmentId: string, threadId: string) =>
    state.forgotten.push({ environmentId, threadId }),
}));
vi.mock("../../state/presentation", () => ({
  connectedEnvironmentIdsAtom: "connected-environments",
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: "server-configs",
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    set: (_atom: string, value: boolean) => {
      state.dropBusy = value;
    },
    get: (atom: string) =>
      atom === "connected-environments"
        ? state.connectedEnvironmentIds
        : atom === "thread-drop-busy"
          ? state.dropBusy
          : atom === "thread-shells"
            ? state.shells
            : atom === "queued-thread-keys"
              ? new Set<string>()
              : new Map(
                  [...state.scopes.keys()].map((environmentId) => [
                    environmentId,
                    {
                      environment: {
                        capabilities: {
                          threadSettlement: true,
                          threadSnooze: true,
                          threadPinning: true,
                          threadPinReorder: true,
                          threadTitleRegeneration: true,
                        },
                      },
                    },
                  ]),
                ),
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("../../state/use-thread-outbox", () => ({ queuedThreadKeysAtom: "queued-thread-keys" }));
vi.mock("../../state/thread-order", () => ({
  threadDropBusyAtom: "thread-drop-busy",
  getPendingThreadOrder: () => state.pendingOrder,
  beginPendingThreadOrder: () => {
    state.pendingOrder = {};
    return {
      isPending: () => state.pendingOrder !== null,
      complete: () => {
        state.pendingOrder = null;
      },
      cancel: () => {
        state.pendingOrder = null;
      },
    };
  },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: {
    threadShellsAtom: "thread-shells",
    navigationThreadShellsAtom: "thread-shells",
  },
  threadEnvironment: Object.fromEntries(
    [
      "archive",
      "unarchive",
      "delete",
      "settle",
      "unsettle",
      "snooze",
      "unsnooze",
      "pin",
      "unpin",
      "reorderPin",
      "reorderActive",
      "updateMetadata",
    ].map((action) => [
      action,
      async (request: {
        environmentId: string;
        input: { threadId: string; orderKey?: string };
      }) => {
        state.requests.push({ action, ...request });
        if (!state.scopes.get(request.environmentId)?.has(AuthOrchestrationOperateScope)) {
          return AsyncResult.failure(Cause.fail(new Error("Thread operation denied")));
        }
        if (action === state.failedAction)
          return AsyncResult.failure(Cause.fail(new Error(state.failureMessage)));
        state.afterRequest?.();
        return AsyncResult.success(undefined);
      },
    ]),
  ),
}));

import { dismissThreadUndoNotice, readThreadUndoNotice } from "./thread-undo-notice";
import { useThreadListActions } from "./useThreadListActions";

const primaryEnvironmentId = EnvironmentId.make("primary");
const otherEnvironmentId = EnvironmentId.make("other");

function makeThread(input: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return makeThreadShellFixture({
    id: ThreadId.make("thread"),
    title: "Thread",
    environmentId: primaryEnvironmentId,
    projectId: ProjectId.make("project"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    ...input,
  });
}

const mutationCases = [
  ["archiveThread", "archive"],
  ["settleThread", "settle"],
  ["unsettleThread", "unsettle"],
  ["snoozeThread", "snooze"],
  ["unsnoozeThread", "unsnooze"],
  ["pinThread", "pin"],
  ["unpinThread", "unpin"],
  ["regenerateThreadTitle", "updateMetadata"],
] as const;

beforeEach(() => {
  state.connectedEnvironmentIds = [primaryEnvironmentId, otherEnvironmentId];
  state.failedAction = null;
  state.failureMessage = "Server rejected action";
  state.forgotten = [];
  state.archivedRefreshes = [];
  state.pendingOrder = null;
  state.dropBusy = false;
  state.scopes = new Map([
    [primaryEnvironmentId, new Set([AuthOrchestrationOperateScope])],
    [otherEnvironmentId, new Set<string>()],
  ]);
  state.requests = [];
  state.shells = [];
  state.dialogs = [];
  state.alerts = [];
  state.afterRequest = undefined;
});

afterEach(() => {
  dismissThreadUndoNotice();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("thread list operation permissions", () => {
  it.each(mutationCases)(
    "%s rejects a retained callback after its environment loses permission",
    async (handler) => {
      const actions = useThreadListActions();
      state.scopes.get(primaryEnvironmentId)!.clear();

      await actions[handler](makeThread(), "2099-01-01T00:00:00.000Z");

      expect(state.requests).toEqual([]);
    },
  );

  it.each(mutationCases)("%s requires the target environment's permission", async (handler) => {
    await useThreadListActions()[handler](
      makeThread({ environmentId: otherEnvironmentId }),
      "2099-01-01T00:00:00.000Z",
    );

    expect(state.requests).toEqual([]);
  });

  it("rechecks permission after a retained delete confirmation", async () => {
    useThreadListActions().confirmDeleteThread(makeThread());
    const confirm = state.dialogs[0]?.onConfirm;
    expect(confirm).toBeTypeOf("function");
    state.scopes.get(primaryEnvironmentId)!.clear();

    await confirm!();

    expect(state.requests).toEqual([]);
  });
});

describe("pinned thread operation permissions", () => {
  it("checks every materialization target before writing any keys", async () => {
    const moved = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z" });
    state.shells = [
      moved,
      makeThread({
        id: ThreadId.make("other-thread"),
        environmentId: otherEnvironmentId,
        pinnedAt: "2026-09-02T00:00:00.000Z",
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
    ];

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(false);
    expect(state.requests).toEqual([]);
  });

  it("moves a keyed thread past a read-only neighbor without writing that neighbor", async () => {
    const moved = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z", pinOrderKey: "m" });
    state.shells = [
      moved,
      makeThread({
        id: ThreadId.make("other-thread"),
        environmentId: otherEnvironmentId,
        pinnedAt: "2026-09-02T00:00:00.000Z",
        pinOrderKey: "g",
      }),
    ];

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(true);
    expect(state.requests).toEqual([
      expect.objectContaining({ action: "reorderPin", environmentId: primaryEnvironmentId }),
    ]);
  });

  it("rechecks permission between materialization writes", async () => {
    const moved = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z" });
    state.shells = [
      moved,
      makeThread({
        id: ThreadId.make("other-thread"),
        pinnedAt: "2026-09-02T00:00:00.000Z",
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
    ];
    state.afterRequest = () => state.scopes.get(primaryEnvironmentId)!.clear();

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(false);
    expect(state.requests).toHaveLength(1);
  });
});

describe("thread reorder connection availability", () => {
  it.each(["active", "pinned"] as const)(
    "rejects %s materialization involving a cached capable offline neighbor",
    async (section) => {
      const moved = makeThread({
        pinnedAt: section === "pinned" ? "2026-09-02T00:00:00.000Z" : null,
      });
      state.shells = [
        moved,
        makeThread({
          id: ThreadId.make("offline-neighbor"),
          environmentId: otherEnvironmentId,
          createdAt: "2026-09-02T00:00:00.000Z",
          pinnedAt: moved.pinnedAt,
        }),
      ];
      state.scopes.get(otherEnvironmentId)?.add(AuthOrchestrationOperateScope);
      state.connectedEnvironmentIds = [primaryEnvironmentId];

      const { moveThread } = useThreadListActions();
      expect(await moveThread(moved, "up")).toBe(false);
      expect(state.requests).toEqual([]);

      state.connectedEnvironmentIds = [primaryEnvironmentId, otherEnvironmentId];

      expect(await moveThread(moved, "up")).toBe(true);
      expect(state.requests).toHaveLength(2);
      expect(new Set(state.requests.map(({ environmentId }) => environmentId))).toEqual(
        new Set([primaryEnvironmentId, otherEnvironmentId]),
      );
    },
  );

  it.each(["active", "pinned"] as const)(
    "uses the latest connection state in a retained %s move callback",
    async (section) => {
      const moved = makeThread({
        pinnedAt: section === "pinned" ? "2026-09-02T00:00:00.000Z" : null,
        pinOrderKey: section === "pinned" ? "m" : null,
        activeOrderKey: section === "active" ? "m" : null,
      });
      state.shells = [
        moved,
        makeThread({
          id: ThreadId.make("offline-neighbor"),
          environmentId: otherEnvironmentId,
          pinnedAt: moved.pinnedAt,
          pinOrderKey: section === "pinned" ? "g" : null,
          activeOrderKey: section === "active" ? "g" : null,
        }),
      ];
      const { moveThread } = useThreadListActions();
      state.connectedEnvironmentIds = [];

      expect(await moveThread(moved, "up")).toBe(false);
      expect(state.requests).toEqual([]);

      state.connectedEnvironmentIds = [primaryEnvironmentId];

      expect(await moveThread(moved, "up")).toBe(true);
      expect(state.requests).toEqual([
        expect.objectContaining({
          action: section === "pinned" ? "reorderPin" : "reorderActive",
          environmentId: primaryEnvironmentId,
        }),
      ]);
    },
  );
});

describe("thread action undo", () => {
  it.each([
    ["settleThread", "settle", "Settled", "unsettle"],
    ["snoozeThread", "snooze", "Snoozed", "unsnooze"],
  ] as const)(
    "%s keeps the successful request's undo when a duplicate is rejected",
    async (handler, action, notice, inverse) => {
      const actions = useThreadListActions();
      const thread = makeThread();
      const first = actions[handler](thread, "2099-01-01T09:00:00.000Z");

      expect(await actions[handler](thread, "2099-01-01T09:00:00.000Z")).toBe(false);
      expect(await first).toBe(true);
      expect(state.requests.map(({ action }) => action)).toEqual([action]);
      expect(readThreadUndoNotice()?.action).toBe(notice);
      await readThreadUndoNotice()!.undo();
      expect(state.requests.map(({ action }) => action)).toEqual([action, inverse]);
    },
  );

  it("keeps the latest unpin undo after concurrent unpin requests", async () => {
    const actions = useThreadListActions();
    const thread = makeThread();
    expect(await Promise.all([actions.unpinThread(thread), actions.unpinThread(thread)])).toEqual([
      true,
      true,
    ]);
    expect(readThreadUndoNotice()?.action).toBe("Unpinned");
    await readThreadUndoNotice()!.undo();
    expect(state.requests.map(({ action }) => action)).toEqual(["unpin", "unpin", "pin"]);
  });

  it("rejects a concurrent archive request without sending another mutation", async () => {
    const actions = useThreadListActions();
    const thread = makeThread();
    const first = actions.archiveThread(thread);
    expect(await actions.archiveThread(thread)).toBe(false);
    expect(await first).toBe(true);
    expect(state.requests.map(({ action }) => action)).toEqual(["archive"]);
    expect(state.archivedRefreshes).toEqual([primaryEnvironmentId]);
  });

  it("restores pin placement and snooze after settling, only once", async () => {
    const thread = makeThread({
      pinnedAt: "2026-09-02T00:00:00.000Z",
      pinOrderKey: "m",
      snoozedUntil: "2099-01-01T09:00:00.000Z",
    });
    expect(await useThreadListActions().settleThread(thread)).toBe(true);
    const undo = readThreadUndoNotice()!.undo;
    expect(readThreadUndoNotice()?.action).toBe("Settled");
    await undo();
    await undo();
    expect(state.requests.map(({ action }) => action)).toEqual([
      "settle",
      "unsettle",
      "pin",
      "snooze",
    ]);
    expect(state.requests[2]?.input).toEqual({ threadId: thread.id, orderKey: "m" });
    expect(state.requests[3]?.input).toEqual({
      threadId: thread.id,
      snoozedUntil: thread.snoozedUntil,
    });
    expect(readThreadUndoNotice()).toBeNull();
  });

  // regression: #21401 restore archive and thread action undo
  it("wakes a snoozed thread through the undo action", async () => {
    const thread = makeThread();
    await useThreadListActions().snoozeThread(thread, "2099-01-01T09:00:00.000Z");
    expect(readThreadUndoNotice()?.action).toBe("Snoozed");
    await readThreadUndoNotice()!.undo();
    expect(state.requests.at(-1)).toMatchObject({
      action: "unsnooze",
      environmentId: thread.environmentId,
      input: { threadId: thread.id, reason: "user" },
    });
  });

  it.each([null, "2099-01-01T09:00:00.000Z", "2000-01-01T09:00:00.000Z"])(
    "restores an unpinned thread's previous position and unexpired snooze (%s)",
    async (snoozedUntil) => {
      const thread = makeThread({
        pinnedAt: "2026-09-02T00:00:00.000Z",
        pinOrderKey: "m",
        snoozedUntil,
      });
      await useThreadListActions().unpinThread(thread);
      expect(readThreadUndoNotice()?.action).toBe("Unpinned");
      await readThreadUndoNotice()!.undo();
      // 2099 is the unexpired case; 2000 has long passed.
      const restoresSnooze = snoozedUntil === "2099-01-01T09:00:00.000Z";
      expect(state.requests.map(({ action }) => action)).toEqual(
        restoresSnooze ? ["unpin", "pin", "snooze"] : ["unpin", "pin"],
      );
      expect(state.requests[1]).toMatchObject({
        action: "pin",
        input: { threadId: thread.id, orderKey: "m" },
      });
      if (restoresSnooze) {
        expect(state.requests[2]).toMatchObject({
          action: "snooze",
          environmentId: thread.environmentId,
          input: { threadId: thread.id, snoozedUntil },
        });
      }
    },
  );

  // regression: #21401 restore archive and thread action undo
  it("does not restore snooze if undoing an unpin fails", async () => {
    const thread = makeThread({
      pinnedAt: "2026-09-02T00:00:00.000Z",
      snoozedUntil: "2099-01-01T09:00:00.000Z",
    });
    await useThreadListActions().unpinThread(thread);
    state.failedAction = "pin";
    await readThreadUndoNotice()!.undo();
    expect(state.requests.map(({ action }) => action)).toEqual(["unpin", "pin"]);
  });

  it("invalidates a retained undo when another hook pins the thread", async () => {
    const thread = makeThread();
    await useThreadListActions().unpinThread(thread);
    const undo = readThreadUndoNotice()!.undo;
    await useThreadListActions().pinThread(thread);
    await undo();
    expect(state.requests.map(({ action }) => action)).toEqual(["unpin", "pin"]);
    expect(readThreadUndoNotice()).toBeNull();
  });

  // regression: #21401 restore archive and thread action undo
  it("does not offer undo for a failed action", async () => {
    state.failedAction = "settle";
    expect(await useThreadListActions().settleThread(makeThread())).toBe(false);
    expect(readThreadUndoNotice()).toBeNull();
  });

  it("stops restoring after a failed inverse command", async () => {
    const thread = makeThread({
      pinnedAt: "2026-09-02T00:00:00.000Z",
      snoozedUntil: "2099-01-01T09:00:00.000Z",
    });
    await useThreadListActions().settleThread(thread);
    state.failedAction = "unsettle";
    await readThreadUndoNotice()!.undo();
    expect(state.requests.map(({ action }) => action)).toEqual(["settle", "unsettle"]);
    expect(state.alerts.at(-1)?.title).toBe("Could not un-settle thread");
  });

  it("rechecks the destination permission before undoing", async () => {
    await useThreadListActions().unpinThread(makeThread());
    state.scopes.get(primaryEnvironmentId)!.clear();
    await readThreadUndoNotice()!.undo();
    expect(state.requests.map(({ action }) => action)).toEqual(["unpin"]);
  });

  // regression: #21401 restore archive and thread action undo
  it("expires undo after five seconds", async () => {
    vi.useFakeTimers();
    await useThreadListActions().unpinThread(makeThread());
    const undo = readThreadUndoNotice()!.undo;
    vi.advanceTimersByTime(5_000);
    expect(readThreadUndoNotice()).toBeNull();
    await undo();
    expect(state.requests.map(({ action }) => action)).toEqual(["unpin"]);
  });

  // regression: #21401 restore archive and thread action undo
  it("refreshes the archive after archiving on a settlement-capable server", async () => {
    await useThreadListActions().archiveThread(makeThread());
    expect(state.requests.map(({ action }) => action)).toEqual(["archive"]);
    expect(state.archivedRefreshes).toEqual([primaryEnvironmentId]);
  });
});

describe("thread action failure dialog", () => {
  const pressButton = (text: string) =>
    state.alerts
      .at(-1)
      ?.buttons?.find((button) => button.text === text)
      ?.onPress?.();

  it("explains a thread its server no longer has and removes it from the list", async () => {
    state.failedAction = "settle";
    state.failureMessage = "No orchestration projection exists for thread mcp:gone.";

    expect(await useThreadListActions().settleThread(makeThread())).toBe(false);

    const alert = state.alerts.at(-1)!;
    expect(alert.title).toBe("Thread no longer exists");
    expect(alert.message).not.toContain("orchestration projection");
    expect(alert.buttons?.map(({ text }) => text)).toEqual(["Keep", "Remove from list"]);
    expect(state.forgotten).toEqual([]);
    pressButton("Remove from list");
    expect(state.forgotten).toEqual([{ environmentId: primaryEnvironmentId, threadId: "thread" }]);
  });

  it("reloads the archive when removing a missing archived thread", async () => {
    state.failedAction = "settle";
    state.failureMessage = "Thread thread is deleted.";

    await useThreadListActions().settleThread(
      makeThread({ archivedAt: "2026-09-02T00:00:00.000Z" }),
    );
    pressButton("Remove from list");

    expect(state.archivedRefreshes).toEqual([primaryEnvironmentId]);
  });

  it("keeps Undo when a retried settle succeeds", async () => {
    const thread = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z" });
    state.failedAction = "settle";

    await useThreadListActions().settleThread(thread);
    state.failedAction = null;
    pressButton("Try again");
    await vi.waitFor(() => expect(readThreadUndoNotice()).not.toBeNull());
    await readThreadUndoNotice()!.undo();

    expect(state.requests.map(({ action }) => action)).toEqual([
      "settle",
      "settle",
      "unsettle",
      "pin",
    ]);
  });

  it("offers no partial retry when an Undo step fails", async () => {
    await useThreadListActions().settleThread(makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z" }));
    state.failedAction = "unsettle";
    await readThreadUndoNotice()!.undo();

    expect(state.alerts.at(-1)?.title).toBe("Could not un-settle thread");
    expect(state.alerts.at(-1)?.buttons?.map(({ text }) => text)).toEqual(["OK"]);
  });

  it("treats a deleted thread as missing", async () => {
    state.failedAction = "settle";
    state.failureMessage = "Thread thread is deleted.";

    await useThreadListActions().settleThread(makeThread());

    expect(state.alerts.at(-1)?.title).toBe("Thread no longer exists");
  });

  it("offers to unarchive an archived thread", async () => {
    state.failedAction = "settle";
    state.failureMessage = "Thread thread is archived.";

    await useThreadListActions().settleThread(makeThread());

    expect(state.alerts.at(-1)?.title).toBe("Thread is archived");
    state.failedAction = null;
    pressButton("Unarchive");
    await vi.waitFor(() =>
      expect(state.requests.map(({ action }) => action)).toEqual(["settle", "unarchive"]),
    );
  });

  it("keeps the server's reason for other failures and can try again", async () => {
    state.failedAction = "settle";

    await useThreadListActions().settleThread(makeThread());

    const alert = state.alerts.at(-1)!;
    expect(alert.title).toBe("Could not settle thread");
    expect(alert.message).toBe("Server rejected action");
    state.failedAction = null;
    pressButton("Try again");
    await vi.waitFor(() =>
      expect(state.requests.map(({ action }) => action)).toEqual(["settle", "settle"]),
    );
  });
});

describe("thread archive guard", () => {
  it("keeps active provider runs out of the archive", async () => {
    const thread = makeThread({
      runtime: {
        status: "running",
        activeRunId: RunId.make("active-run"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "codex",
        lastError: null,
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    });
    expect(await useThreadListActions().archiveThread(thread)).toBe(false);
    expect(state.requests).toEqual([]);
    expect(state.archivedRefreshes).toEqual([]);
    expect(state.alerts.at(-1)?.title).toBe("Could not archive thread");
  });
});
