import { ProviderInstanceId } from "@t3tools/contracts";
import {
  newOrbitThreadStart,
  orbitCompletionNeedsFollow,
  orbitCompletionPhase,
  type OrbitGatewayClient,
  type OrbitGatewayOperation,
  type OrbitThreadStart,
} from "@t3tools/client-runtime/orbit-gateway";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useWorkspaceStore } from "../workspaceStore";
import type { Workspace } from "../workspaces.logic";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { buildOrbitDraftStart, type OrbitDraftTarget } from "./orbitDraft";
import {
  cancelOrbitThreadStart,
  dismissOrbitThreadStart,
  followSavedOrbitCompletion,
  resumeSavedOrbitCompletionRetry,
  retrySavedOrbitCompletion,
  retryOrbitThreadStart,
  runSavedOrbitThreadStart,
  sendOrbitDraft,
  startOrbitInstanceFromPlus,
} from "./orbitThreadStarts";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "../state/projects";
import { environmentServerConfigsAtom } from "../state/server";
import { readStored, updateStarts } from "./orbitThreadStartStore";

const runner = vi.hoisted(() => ({ real: false }));
vi.mock("@t3tools/client-runtime/orbit-gateway", async (importOriginal) => {
  const original = await importOriginal<typeof import("@t3tools/client-runtime/orbit-gateway")>();
  return {
    ...original,
    // Unless a test runs the real one: the clone is created and paired; only the first message is left.
    runOrbitThreadStart: async (
      start: Parameters<typeof original.runOrbitThreadStart>[0],
      ports: Parameters<typeof original.runOrbitThreadStart>[1],
    ) => {
      if (runner.real) return original.runOrbitThreadStart(start, ports);
      // A start with no message ends connected, without a send.
      if (start.message === "") {
        ports.save({ ...start, environmentId: "clone", instanceId: 41, connected: true });
        return true;
      }
      const sent = await ports.send({ ...start, environmentId: "clone" });
      ports.save({ ...start, ...sent, environmentId: "clone", sentAt: 1 });
      return true;
    },
    sendOrbitFirstMessage: async () => "ws",
  };
});
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: vi.fn(),
  squashAtomCommandFailure: vi.fn(),
}));
vi.mock("../lib/utils", () => ({
  newMessageId: () => "message-1",
  newThreadId: () => "thread-1",
  randomUUID: () => "start-1",
}));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: {} } }));
vi.mock("../connection/onboarding", () => ({ connectPairing: {} }));
vi.mock("../providerInstances", () => ({
  providerInstanceEntriesFor: vi.fn(),
  resolveProjectDefaultProviderModelSelection: vi.fn(),
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: vi.fn() } }));
vi.mock("../state/projects", () => ({ environmentProjects: { projectsAtom: {} } }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../state/threads", () => ({ threadEnvironment: { startTurn: {} } }));
vi.mock("../state/waitForAtomValue", () => ({ waitForAtomValue: async () => true }));
vi.mock("./environmentProvider", () => ({
  recordOrbitPaired: vi.fn(),
  useEnvironmentProvider: { getState: () => ({ provider: "orbit" }) },
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

const projectTarget: OrbitDraftTarget = {
  projectId: 3,
  projectSlug: "bench",
  projectName: "Bench",
  nodeName: "beast",
  instanceKind: "new",
  instanceName: "",
  existing: null,
  domainSuffix: null,
};
const client = {} as OrbitGatewayClient;
const workspace = (id: string, extra: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  projectKeys: [],
  projectRefs: ["beast:bench"],
  color: "blue",
  icon: null,
  ...extra,
});

/** Starts a thread with `selected` chosen, lets `between` run, then sends the first message. */
async function startAndSend(selected: string | null, between: () => void = () => {}) {
  useWorkspaceStore.setState({ activeWorkspaceId: selected });
  sendOrbitDraft({
    start: buildOrbitDraftStart({
      target: { ...projectTarget, instanceName: "list-files" },
      message: "List the files",
      modelSelection: null,
      runtimeMode: "full-access",
      interactionMode: "default",
    }),
    openPending: () => {},
    clearDraft: () => {},
  });
  const id = readStored()[0]!.id;
  between();
  expect(await runSavedOrbitThreadStart(client, id)).toEqual({
    environmentId: "clone",
    threadId: "thread-1",
  });
  return useWorkspaceStore.getState().workspaces;
}

describe("runSavedOrbitThreadStart", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: createLocalStorageStub(),
      desktopBridge: { orbitGatewaySend: vi.fn() },
    });
    useWorkspaceStore.setState({
      workspaces: [workspace("S"), workspace("U")],
      activeWorkspaceId: null,
      availableProjects: [],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("ends a start with no message once connected: its Instance, no thread, and the project joins the workspace", async () => {
    vi.mocked(appAtomRegistry.get).mockImplementation(((atom: unknown) =>
      atom === environmentProjects.projectsAtom
        ? [{ environmentId: "clone", workspaceRoot: "/srv/workspace", id: "ws" }]
        : atom === environmentServerConfigsAtom
          ? new Map([["clone", { providers: [], settings: { defaultModelSelection: null } }]])
          : undefined) as never);
    useWorkspaceStore.setState({ activeWorkspaceId: "S" });
    const start = startOrbitInstanceFromPlus({ ...projectTarget, instanceName: "abc" });
    expect(start).toMatchObject({ message: "", instanceName: "abc", branch: null });

    expect(await runSavedOrbitThreadStart(client, start!.id)).toEqual({
      environmentId: "clone",
      threadId: null,
    });
    expect(readStored()[0]).toMatchObject({ connected: true, sentAt: null, error: null });
    expect(useWorkspaceStore.getState().workspaces[0]!.projectRefs).toEqual([
      "beast:bench",
      "clone:ws",
    ]);
    vi.mocked(appAtomRegistry.get).mockReset();
  });

  it("adds the clone's project to the workspace selected at Start once the message is sent", async () => {
    // Nick moves on to workspace U while the clone is made.
    const workspaces = await startAndSend("S", () =>
      useWorkspaceStore.getState().selectWorkspace("U"),
    );

    expect(workspaces.map((entry) => entry.projectRefs)).toEqual([
      ["beast:bench", "clone:ws"],
      ["beast:bench"],
    ]);
  });

  it("changes no workspace for a start with all projects, or whose workspace is gone", async () => {
    const before = useWorkspaceStore.getState().workspaces;
    expect(await startAndSend(null)).toBe(before);

    window.localStorage.clear();
    expect(
      await startAndSend("S", () => useWorkspaceStore.getState().deleteWorkspace("S")),
    ).toEqual([workspace("U")]);
  });

  it("leaves a workspace that already lists the clone's project as it is", async () => {
    const byKey = workspace("S", { projectKeys: ["/srv/workspace"] });
    useWorkspaceStore.setState({
      workspaces: [byKey],
      availableProjects: [
        { projectKey: "/srv/workspace", displayName: "workspace", refs: ["clone:ws"] },
      ],
    });

    expect((await startAndSend("S"))[0]).toBe(byKey);
  });
});

describe("cancelOrbitThreadStart", () => {
  beforeEach(() => {
    runner.real = true;
    vi.stubGlobal("window", {
      localStorage: createLocalStorageStub(),
      desktopBridge: { orbitGatewaySend: vi.fn() },
    });
  });
  afterEach(() => {
    runner.real = false;
    vi.unstubAllGlobals();
  });

  const saveDraftStart = () => {
    sendOrbitDraft({
      start: buildOrbitDraftStart({
        target: { ...projectTarget, instanceName: "list-files" },
        message: "List the files",
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
      openPending: () => {},
      clearDraft: () => {},
    });
    return readStored()[0]!.id;
  };

  it("cancels the create Orbit admits after a Cancel during admission, then drops the start", async () => {
    const id = saveDraftStart();
    const admission = deferred();
    const admitting = deferred();
    const cancelOperation = vi.fn(async () => ({}));
    const gateway = {
      createThreadInstance: async () => {
        admitting.resolve();
        await admission.promise;
        return {
          id: 100,
          kind: "instance.create",
          status: "queued",
          targetId: 41,
          errorCode: null,
          pollAfterSeconds: 2,
        };
      },
      cancelOperation,
    } as unknown as OrbitGatewayClient;
    const run = runSavedOrbitThreadStart(gateway, id);
    await admitting.promise;

    expect(await cancelOrbitThreadStart(gateway, id)).toEqual({
      instanceStays: true,
      requested: true,
    });
    expect(readStored()[0]).toMatchObject({ id, cancelRequested: true });
    expect(cancelOperation).not.toHaveBeenCalled();

    admission.resolve();
    expect(await run).toBeNull();
    expect(cancelOperation).toHaveBeenCalledWith(100);
    expect(readStored()).toEqual([]);
  });

  it("cancels the create a runner repeats after a Cancel from a window that runs no start", async () => {
    const id = saveDraftStart();
    // The main window sent the create, then the answer was lost (or the app reloaded).
    updateStarts((starts) => starts.map((entry) => ({ ...entry, createKey: "key-1" })));
    const createThreadInstance = vi.fn(async () => ({
      id: 100,
      kind: "instance.create",
      status: "queued",
      targetId: 41,
      errorCode: null,
      pollAfterSeconds: 2,
    }));
    const cancelOperation = vi.fn(async () => ({}));
    const gateway = { createThreadInstance, cancelOperation } as unknown as OrbitGatewayClient;

    expect(await cancelOrbitThreadStart(gateway, id)).toEqual({
      instanceStays: true,
      requested: true,
    });
    expect(readStored()[0]).toMatchObject({ id, cancelRequested: true });
    expect(cancelOperation).not.toHaveBeenCalled();

    expect(await runSavedOrbitThreadStart(gateway, id)).toBeNull();
    expect(createThreadInstance).toHaveBeenCalledWith(3, "list-files", "key-1", null);
    expect(cancelOperation).toHaveBeenCalledWith(100);
    expect(readStored()).toEqual([]);
  });

  it("drops a start whose create was never sent at once, without a Gateway call", async () => {
    const id = saveDraftStart();
    expect(readStored()[0]!.createKey).toBeNull();
    const cancelOperation = vi.fn();
    const gateway = { cancelOperation } as unknown as OrbitGatewayClient;
    expect(await cancelOrbitThreadStart(gateway, id)).toEqual({
      instanceStays: false,
      requested: false,
    });
    expect(readStored()).toEqual([]);
    expect(cancelOperation).not.toHaveBeenCalled();
  });
});

describe("sendOrbitDraft", () => {
  const target: OrbitDraftTarget = {
    projectId: 71,
    projectSlug: "nckrtl",
    projectName: "nckrtl.com",
    nodeName: "beast",
    instanceKind: "new",
    instanceName: "pricing-page",
    existing: null,
    domainSuffix: ".nckrtl.test",
  };
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claude"),
    model: "claude-opus-5-5",
  };
  const send = (draftTarget: OrbitDraftTarget, navigation?: Promise<void>) => {
    const events: string[] = [];
    const sent = sendOrbitDraft({
      start: buildOrbitDraftStart({
        target: draftTarget,
        message: "Add a pricing page",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }),
      openPending: (route) => {
        events.push(`open ${route}`);
        return navigation;
      },
      clearDraft: () => events.push(`clear after ${readStored().length} saved`),
    });
    return { sent, start: readStored()[0]!, events };
  };

  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: createLocalStorageStub(),
      desktopBridge: { orbitGatewaySend: vi.fn() },
    });
    useWorkspaceStore.setState({ workspaces: [workspace("S")], activeWorkspaceId: "S" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("saves a start, opens its pending thread, and clears the draft only after that", async () => {
    const navigation = deferred();
    const { start, events } = send(target, navigation.promise);
    // The draft route redirects home once its draft is gone, so the clear waits for the route.
    await Promise.resolve();
    expect(events).toEqual(["open /orbit/start-1"]);
    navigation.resolve();
    await navigation.promise;
    await Promise.resolve();

    expect(start).toMatchObject({
      projectId: 71,
      projectSlug: "nckrtl",
      nodeName: "beast",
      message: "Add a pricing page",
      instanceName: "pricing-page",
      orbitInstanceKind: "new",
      environmentId: null,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      workspaceId: "S",
      pendingThread: true,
      projectName: "nckrtl.com",
      instanceDomainSuffix: ".nckrtl.test",
    });
    expect(events).toEqual(["open /orbit/start-1", "clear after 1 saved"]);
    // The start machine sends later; nothing goes through a T3 server now.
    expect(runAtomCommand).not.toHaveBeenCalled();
  });

  it("saves a new Instance's branch choice and the default branch", () => {
    const onBranch: OrbitDraftTarget = {
      ...target,
      branch: { mode: "existing", name: "feature/login" },
      defaultBranch: "main",
    };
    expect(send(onBranch).start).toMatchObject({
      branch: { mode: "existing", name: "feature/login" },
      defaultBranch: "main",
    });
    window.localStorage.clear();
    expect(send({ ...onBranch, branch: null }).start).toMatchObject({
      branch: null,
      defaultBranch: "main",
    });
    // The default branch's name could not be read: the start still goes, with no branch.
    window.localStorage.clear();
    expect(send({ ...onBranch, branch: null, defaultBranch: null }).start).toMatchObject({
      branch: null,
      defaultBranch: null,
    });
  });

  it("starts in an existing, unpaired Instance without a create", () => {
    const { start } = send({
      ...target,
      instanceKind: "existing",
      instanceName: "checkout",
      existing: { instanceId: 2055, environmentId: "env-2055" },
    });

    expect(start).toMatchObject({
      instanceName: "checkout",
      orbitInstanceKind: "existing",
      instanceId: 2055,
      environmentId: "env-2055",
    });
  });

  it("still clears the draft when the navigation fails", async () => {
    const navigation = deferred();
    const { events } = send(target, navigation.promise);
    navigation.reject(new Error("blocked"));
    await navigation.promise.catch(() => {});
    await Promise.resolve();
    expect(events).toEqual(["open /orbit/start-1", "clear after 1 saved"]);
  });

  it("saves nothing and keeps the draft when the window cannot run a start", () => {
    vi.stubGlobal("window", { localStorage: createLocalStorageStub() });
    const { sent, events } = send(target);
    expect(sent).toBeNull();
    expect(readStored()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("keeps a pending thread's start after the send, for the real thread's ready row", async () => {
    const { start } = send(target);
    expect(await runSavedOrbitThreadStart(client, start.id)).toEqual({
      environmentId: "clone",
      threadId: "thread-1",
    });
    expect(readStored()).toEqual([
      expect.objectContaining({ id: start.id, sentAt: expect.any(Number), modelFallback: null }),
    ]);
    // A sent start never runs again.
    expect(await runSavedOrbitThreadStart(client, start.id)).toBeNull();
  });

  it("Retry clears the error and the times of the stages that run again; Dismiss drops only the start", () => {
    const { start } = send(target);
    window.localStorage.setItem(
      "conn:orbit-thread-starts:v1",
      JSON.stringify([
        {
          ...start,
          environmentId: "env-1",
          instanceId: 9,
          createStartedAt: 1,
          connectStartedAt: 5,
          error: "Orbit could not pair.",
        },
      ]),
    );
    retryOrbitThreadStart(start.id);
    expect(readStored()[0]).toMatchObject({
      error: null,
      createStartedAt: 1,
      connectStartedAt: null,
    });

    dismissOrbitThreadStart(start.id);
    expect(readStored()).toEqual([]);
    expect(runAtomCommand).not.toHaveBeenCalled();
  });

  it("resumes an unsent start of the old sidebar dialog as a pending thread", async () => {
    const { start } = send(target);
    const {
      pendingThread: _pending,
      projectName: _name,
      instanceDomainSuffix: _suffix,
      sentAt: _sentAt,
      ...dialogRow
    } = start;
    window.localStorage.setItem("conn:orbit-thread-starts:v1", JSON.stringify([dialogRow]));

    expect(await runSavedOrbitThreadStart(client, start.id)).toEqual({
      environmentId: "clone",
      threadId: "thread-1",
    });
    // Kept like any pending thread's start, for the real thread's ready row.
    expect(readStored()).toEqual([
      expect.objectContaining({ id: start.id, pendingThread: true, sentAt: expect.any(Number) }),
    ]);
  });

  it("drops an old dialog start whose send finished before a quit, without running it", async () => {
    const { start } = send(target);
    const { pendingThread: _pending, ...dialogRow } = start;
    window.localStorage.setItem(
      "conn:orbit-thread-starts:v1",
      JSON.stringify([{ ...dialogRow, environmentId: "clone", connected: true, sentAt: 4 }]),
    );
    expect(await runSavedOrbitThreadStart(client, start.id)).toBeNull();
    expect(readStored()).toEqual([]);
  });
});

describe("followSavedOrbitCompletion", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: createLocalStorageStub(),
      desktopBridge: { orbitGatewaySend: vi.fn() },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  /** A start saved by an earlier run of the app: sent, its completion 106 still running. */
  const saved: OrbitThreadStart = {
    ...newOrbitThreadStart({
      id: "s-restart",
      project: { id: 3, slug: "bench", nodeName: "beast" },
      message: "List the files",
      suffix: "x",
      threadId: "thread-r",
      messageId: "message-r",
      commandId: "command-r",
      now: 0,
      pendingThread: true,
    }),
    createOperationId: 100,
    instanceId: 41,
    environmentId: "clone",
    connected: true,
    sentAt: 10,
    completionOperationId: 106,
    completionStatus: "running",
    createRows: {
      container: { status: "done", startedAt: 1, finishedAt: 2 },
      address: { status: "running", startedAt: 3, finishedAt: null },
      t3: { status: "done", startedAt: 2, finishedAt: 3 },
      register: { status: "done", startedAt: 3, finishedAt: 4 },
    },
  };
  const read = (
    status: OrbitGatewayOperation["status"],
    extra: Partial<OrbitGatewayOperation> = {},
  ) =>
    ({
      id: 106,
      kind: "instance.complete",
      status,
      targetId: 41,
      errorCode: null,
      pollAfterSeconds: null,
      steps: [],
      ...extra,
    }) satisfies OrbitGatewayOperation;

  it("resumes after a restart from the saved Operation id and follows it once", async () => {
    updateStarts(() => [saved]);
    const operation = vi.fn(async (id: number) => {
      expect(id).toBe(106);
      return read("succeeded");
    });
    const gatewayClient = { operation } as unknown as OrbitGatewayClient;
    await Promise.all([
      followSavedOrbitCompletion(gatewayClient, saved.id),
      followSavedOrbitCompletion(gatewayClient, saved.id),
    ]);
    expect(operation).toHaveBeenCalledTimes(1);
    const after = readStored()[0]!;
    expect(orbitCompletionPhase(after)).toBe("succeeded");
    expect(after.createRows?.address?.status).toBe("done");
    expect(orbitCompletionNeedsFollow(after)).toBe(false);
  });

  it("a removal's cancel changes no row; the removal then drops the start", async () => {
    updateStarts(() => [saved]);
    const gatewayClient = {
      operation: async () => read("cancelled", { cancelRequested: true }),
    } as unknown as OrbitGatewayClient;
    await followSavedOrbitCompletion(gatewayClient, saved.id);
    const after = readStored()[0]!;
    expect(after.createRows).toEqual(saved.createRows);
    expect(orbitCompletionPhase(after)).toBe("removed");
    expect(after.error).toBeNull();
  });

  it("Retry from any window only saves it; the main window's runner sends it once", async () => {
    updateStarts(() => [{ ...saved, completionStatus: "failed", completionRetryable: true }]);
    retrySavedOrbitCompletion(saved.id);
    const marked = readStored()[0]!;
    expect(marked.completionOperationId).toBeNull();
    expect(marked.completionKey).toMatch(/^conn-thread-start:s-restart:complete:/);
    expect(orbitCompletionPhase(marked)).toBe("running");
    expect(orbitCompletionNeedsFollow(marked)).toBe(false);
    const completeInstance = vi.fn(async () => read("queued", { id: 107, pollAfterSeconds: 2 }));
    await resumeSavedOrbitCompletionRetry(
      { completeInstance } as unknown as OrbitGatewayClient,
      saved.id,
    );
    expect(completeInstance).toHaveBeenCalledWith(41, marked.completionKey);
    const after = readStored()[0]!;
    expect(after.completionOperationId).toBe(107);
    expect(orbitCompletionNeedsFollow(after)).toBe(true);
  });

  it("a Retry cut off by a restart is sent again once, under its saved key", async () => {
    updateStarts(() => [
      {
        ...saved,
        completionOperationId: null,
        completionKey: "conn-thread-start:s-restart:complete:5",
        completionStatus: "queued",
      },
    ]);
    const completeInstance = vi.fn(async () => read("running", { id: 107, pollAfterSeconds: 2 }));
    const gatewayClient = { completeInstance } as unknown as OrbitGatewayClient;
    await Promise.all([
      resumeSavedOrbitCompletionRetry(gatewayClient, saved.id),
      resumeSavedOrbitCompletionRetry(gatewayClient, saved.id),
    ]);
    expect(completeInstance).toHaveBeenCalledTimes(1);
    expect(completeInstance).toHaveBeenCalledWith(41, "conn-thread-start:s-restart:complete:5");
    expect(readStored()[0]!.completionOperationId).toBe(107);
  });

  it("Dismiss drops the start; the follow stops without saving it back", async () => {
    updateStarts(() => [saved]);
    const gatewayClient = {
      operation: async () => {
        dismissOrbitThreadStart(saved.id);
        return read("succeeded");
      },
    } as unknown as OrbitGatewayClient;
    await followSavedOrbitCompletion(gatewayClient, saved.id);
    expect(readStored()).toEqual([]);
  });
});
