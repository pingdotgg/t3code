import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Map<string, Set<string>>(),
  shells: [] as EnvironmentThreadShell[],
  requests: [] as {
    action: string;
    environmentId: string;
    input: { threadId: string; orderKey?: string };
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
vi.mock("../../components/ConfirmDialogHost", () => ({
  showConfirmDialog: (dialog: { onConfirm: () => void }) => state.dialogs.push(dialog),
}));
vi.mock("../archive/useArchivedThreadSnapshots", () => ({
  refreshArchivedThreadsForEnvironment: () => {},
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: "server-configs",
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: string) =>
      atom === "thread-shells"
        ? state.shells
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
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellsAtom: "thread-shells" },
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
        state.afterRequest?.();
        return AsyncResult.success(undefined);
      },
    ]),
  ),
}));

import { useArchivedThreadListActions, useThreadListActions } from "./useThreadListActions";

const primaryEnvironmentId = EnvironmentId.make("primary");
const otherEnvironmentId = EnvironmentId.make("other");

function makeThread(input: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: ThreadId.make("thread"),
    title: "Thread",
    environmentId: primaryEnvironmentId,
    projectId: ProjectId.make("project"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
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

afterEach(() => vi.unstubAllEnvs());

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

  it.each(mutationCases)(
    "%s works when the target environment gains only task permission",
    async (handler, action) => {
      state.scopes.get(primaryEnvironmentId)!.clear();
      const actions = useThreadListActions();
      state.scopes.get(otherEnvironmentId)!.add(AuthOrchestrationOperateScope);

      await actions[handler](
        makeThread({ environmentId: otherEnvironmentId }),
        "2099-01-01T00:00:00.000Z",
      );

      expect(state.requests).toEqual([
        expect.objectContaining({ action, environmentId: otherEnvironmentId }),
      ]);
    },
  );

  it.each(["ios", "android"])("does not show a forbidden %s delete confirmation", (os) => {
    vi.stubEnv("EXPO_OS", os);
    useThreadListActions().confirmDeleteThread(makeThread({ environmentId: otherEnvironmentId }));

    expect(state.dialogs).toEqual([]);
    expect(state.alerts.some((alert) => alert.title === "Delete thread?")).toBe(false);
    expect(state.requests).toEqual([]);
  });

  it.each(["ios", "android"])(
    "rechecks permission after a retained %s delete confirmation",
    async (os) => {
      vi.stubEnv("EXPO_OS", os);
      useThreadListActions().confirmDeleteThread(makeThread());
      const confirm =
        os === "ios"
          ? state.alerts[0]?.buttons?.find((button) => button.text === "Delete")?.onPress
          : state.dialogs[0]?.onConfirm;
      expect(confirm).toBeTypeOf("function");
      state.scopes.get(primaryEnvironmentId)!.clear();

      await confirm!();

      expect(state.requests).toEqual([]);
    },
  );

  it("unarchives with only task permission and blocks a later revoked callback", async () => {
    const actions = useArchivedThreadListActions(() => {});
    const thread = makeThread({ archivedAt: "2026-09-02T00:00:00.000Z" });
    await actions.unarchiveThread(thread);
    expect(state.requests).toEqual([expect.objectContaining({ action: "unarchive" })]);
    state.requests = [];
    state.scopes.get(primaryEnvironmentId)!.clear();

    await actions.unarchiveThread(thread);

    expect(state.requests).toEqual([]);
  });

  it("keeps delete independent of terminal and source-control permissions", async () => {
    vi.stubEnv("EXPO_OS", "android");
    useArchivedThreadListActions(() => {}).confirmDeleteThread(makeThread());
    await state.dialogs[0]!.onConfirm();

    expect(state.requests).toEqual([expect.objectContaining({ action: "delete" })]);
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

    expect(await useThreadListActions().movePinnedThread(moved, "up")).toBe(false);
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

    expect(await useThreadListActions().movePinnedThread(moved, "up")).toBe(true);
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

    expect(await useThreadListActions().movePinnedThread(moved, "up")).toBe(false);
    expect(state.requests).toHaveLength(1);
  });
});
