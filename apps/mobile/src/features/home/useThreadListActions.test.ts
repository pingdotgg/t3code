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
  archivedRefreshes: [] as string[],
  scopes: new Map<string, Set<string>>(),
  offlineTriage: new Set<string>(),
  successValues: new Map<string, unknown>(),
  shells: [] as EnvironmentThreadShell[],
  requests: [] as {
    action: string;
    environmentId: string;
    input: { threadId: string; orderKey?: string; snoozedUntil?: string; reason?: string };
  }[],
  dialogs: [] as { onConfirm: () => void }[],
  alerts: [] as {
    title: string;
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
    alert: (title: string, _message: string, buttons?: { text: string; onPress?: () => void }[]) =>
      state.alerts.push({ title, buttons }),
  },
}));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (title: string, _message: string, buttons?: { text: string; onPress?: () => void }[]) =>
    state.alerts.push({ title, buttons }),
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
        : atom.startsWith("offline-triage:")
          ? state.offlineTriage.has(atom.slice("offline-triage:".length))
          : atom.startsWith("pending-sync:")
            ? new Set<string>()
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
  threadEnvironment: {
    offlineTriagePermittedAtom: (environmentId: string) => `offline-triage:${environmentId}`,
    pendingSyncAtom: (environmentId: string) => `pending-sync:${environmentId}`,
    ...Object.fromEntries(
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
          const triage = ["settle", "unsettle", "snooze", "unsnooze"].includes(action);
          if (
            !state.scopes.get(request.environmentId)?.has(AuthOrchestrationOperateScope) &&
            !(triage && state.offlineTriage.has(request.environmentId))
          ) {
            return AsyncResult.failure(Cause.fail(new Error("Thread operation denied")));
          }
          if (action === state.failedAction)
            return AsyncResult.failure(Cause.fail(new Error("Server rejected action")));
          state.afterRequest?.();
          return AsyncResult.success(state.successValues.get(action));
        },
      ]),
    ),
  },
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
  state.archivedRefreshes = [];
  state.pendingOrder = null;
  state.dropBusy = false;
  state.offlineTriage = new Set();
  state.successValues = new Map();
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

  // Offline, the session may not have loaded; only settle, snooze and their undo may queue.
  it.each(mutationCases)(
    "%s without a loaded session follows the remembered offline triage permission",
    async (handler, action) => {
      state.scopes.get(primaryEnvironmentId)!.clear();
      state.offlineTriage.add(primaryEnvironmentId);

      await useThreadListActions()[handler](makeThread(), "2099-01-01T00:00:00.000Z");

      const triage = ["settle", "unsettle", "snooze", "unsnooze"].includes(action);
      expect(state.requests.map((request) => request.action)).toEqual(triage ? [action] : []);
    },
  );

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

  it("restores snooze with the remembered grant if the session disappears during Undo", async () => {
    const thread = makeThread({ snoozedUntil: "2099-01-01T09:00:00.000Z" });
    expect(await useThreadListActions().settleThread(thread)).toBe(true);
    state.afterRequest = () => {
      state.scopes.delete(primaryEnvironmentId);
      state.offlineTriage.add(primaryEnvironmentId);
    };

    await readThreadUndoNotice()!.undo();

    expect(state.requests.map(({ action }) => action)).toEqual(["settle", "unsettle", "snooze"]);
    expect(state.requests.at(-1)?.input).toEqual({
      threadId: thread.id,
      snoozedUntil: thread.snoozedUntil,
    });
    expect(state.alerts).toEqual([]);
  });

  // Whether the queued settle reached the server is known only when Undo runs.
  it.each([
    ["cancels it before it syncs", { sequence: 0, cancelledPendingSync: true }, ["snooze"]],
    ["finds it delivered", { sequence: 3 }, ["pin", "snooze"]],
  ])("restores a queued settle only as far as needed when Undo %s", async (_, undone, restored) => {
    state.successValues.set("settle", { sequence: 1, pendingSync: true });
    state.successValues.set("unsettle", undone);
    const thread = makeThread({
      pinnedAt: "2026-09-02T00:00:00.000Z",
      pinOrderKey: "m",
      snoozedUntil: "2099-01-01T09:00:00.000Z",
    });
    expect(await useThreadListActions().settleThread(thread)).toBe(true);
    expect(readThreadUndoNotice()?.action).toBe("Settled");
    await readThreadUndoNotice()!.undo();
    expect(state.requests.map(({ action }) => action)).toEqual(["settle", "unsettle", ...restored]);
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
