import {
  newOrbitThreadStart,
  type OrbitGatewayClient,
  type OrbitGatewayOperation,
} from "@t3tools/client-runtime/orbit-gateway";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../lib/atomic-file", () => ({ writeFileAtomically: vi.fn() }));

import {
  createOrbitThreadStartStore,
  dismissOrbitThreadStart,
  heldOrbitInstanceIds,
  orbitThreadStartRow,
  parseOrbitThreadStarts,
  retryOrbitThreadStart,
  type OrbitThreadStartStorage,
} from "./orbitThreadStartStore";
import {
  beginOrbitThreadStart,
  followSavedOrbitCompletion,
  orbitCompletionSettled,
  orbitStartReturn,
  orbitSentStartStep,
  retrySavedOrbitCompletion,
  runSavedOrbitThreadStart,
  runSentOrbitThreadStart,
  type MobileOrbitThreadStartPorts,
} from "./orbitThreadStarts";

const project = {
  id: 66,
  slug: "create-bench",
  name: "Create bench",
  nodeId: 7,
  nodeName: "beast",
  instanceDomainSuffix: ".create-bench.test",
};

/** A file that keeps what was last written, as the app's documents folder does across restarts. */
function memoryFile(initial: string | null = null) {
  const file = { text: initial, writes: 0 };
  const storage: OrbitThreadStartStorage = {
    load: async () => file.text,
    save: async (text) => {
      file.writes += 1;
      file.text = text;
    },
  };
  return { file, storage };
}

function uuids() {
  let next = 0;
  return () => `id-${++next}`;
}

function op(id: number, targetId: number, status: OrbitGatewayOperation["status"]) {
  return { id, kind: "x", status, targetId, errorCode: null, pollAfterSeconds: 0 };
}

/** A Gateway that creates clone 41 with server env-41 and pairs it, recording each call. */
function gateway() {
  const calls: string[] = [];
  const client = {
    createThreadInstance: async (projectId: number) => {
      calls.push(`create ${projectId}`);
      return op(100, 41, "queued");
    },
    operation: async (id: number) => op(id, id === 100 ? 41 : 9, "succeeded"),
    environments: async () => [
      {
        environmentId: "env-41",
        label: "create-bench / clone",
        url: "http://10.44.0.7:3800",
        serverVersion: null,
        registeredBy: "beast",
        registeredAt: null,
        status: "registered",
        instanceId: 41,
        powerState: "running",
        projectId: null,
        projectName: null,
        projectSlug: null,
        instanceName: null,
        nodeName: null,
        instanceUrl: null,
      },
    ],
    startPairing: async (environmentId: string) => {
      calls.push(`pair ${environmentId}`);
      return op(200, 9, "queued");
    },
    readPairing: async (environmentId: string) => ({
      environmentId,
      pairingUrl: "http://10.44.0.7:3800/pair#token=t",
      expiresAt: "",
    }),
  } as unknown as OrbitGatewayClient;
  return { client, calls };
}

function ports(
  store: MobileOrbitThreadStartPorts["store"],
  overrides: Partial<MobileOrbitThreadStartPorts> = {},
) {
  const saved = new Set<string>();
  const kept: Array<[string | null, string]> = [];
  const launches: string[] = [];
  const { client, calls } = gateway();
  const value: MobileOrbitThreadStartPorts = {
    store,
    gateway: client,
    orbitMode: () => true,
    catalogReady: async () => true,
    isSaved: (environmentId) => saved.has(environmentId),
    connect: async (environmentId) => {
      calls.push(`connect ${environmentId}`);
      saved.add(environmentId);
    },
    firstMessage: {
      waitForClone: async () => ({
        projectId: ProjectId.make("workspace"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      }),
      startTurn: async (environmentId, input) => {
        launches.push(`${environmentId} ${input.threadId} ${input.message.text}`);
        return { ok: true };
      },
      now: () => "2026-11-10T12:00:00.000Z",
    },
    keepInWorkspace: async (workspaceId, ref) => {
      kept.push([workspaceId, ref]);
    },
    sleep: async () => {},
    now: () => 0,
    ...overrides,
  };
  return { ports: value, calls, kept, launches };
}

describe("Orbit thread starts on the phone", () => {
  it("creates one clone, pairs once, sends the first message and adds the ref to the workspace", async () => {
    const { storage } = memoryFile();
    const store = createOrbitThreadStartStore(storage);
    await store.load();
    const start = beginOrbitThreadStart(store, {
      project,
      message: "List the files in this folder",
      workspaceId: "work",
      uuid: uuids(),
      now: 0,
    });
    const run = ports(store);

    expect(await runSavedOrbitThreadStart(start.id, run.ports)).toEqual({
      environmentId: "env-41",
      threadId: start.threadId,
    });
    expect(run.calls).toEqual(["create 66", "pair env-41", "connect env-41"]);
    expect(run.launches).toEqual([`env-41 ${start.threadId} List the files in this folder`]);
    expect(run.kept).toEqual([["work", "env-41:workspace"]]);
    // No completion (an older Gateway): the runner's next pass drops the sent start.
    expect(orbitSentStartStep(store.starts()[0]!)).toBe("drop");
    await runSentOrbitThreadStart(store.starts()[0]!, run.ports);
    expect(store.starts()).toEqual([]);
  });

  it("resumes a start saved mid-pairing after a restart without a second create", async () => {
    const { storage } = memoryFile();
    const before = createOrbitThreadStartStore(storage);
    await before.load();
    const start = beginOrbitThreadStart(before, {
      project,
      message: "Fix it",
      workspaceId: null,
      uuid: uuids(),
      now: 0,
    });
    before.save({ ...start, createOperationId: 100, instanceId: 41, environmentId: "env-41" });
    await before.flush();

    const after = createOrbitThreadStartStore(storage);
    await after.load();
    expect(heldOrbitInstanceIds(after)).toEqual([41]);
    // The row's "Publish the address" shows the address with the listed domain.
    expect(after.starts()[0]!.instanceDomainSuffix).toBe(".create-bench.test");
    expect(orbitThreadStartRow(after.starts()[0]!)).toMatchObject({ stage: "pairing" });
    const run = ports(after);
    expect(await runSavedOrbitThreadStart(start.id, run.ports)).not.toBeNull();
    expect(run.calls).toEqual(["pair env-41", "connect env-41"]);
  });

  it("shows a stopped start with its error; Retry runs it again and Dismiss removes it", async () => {
    const store = createOrbitThreadStartStore(memoryFile().storage);
    const start = beginOrbitThreadStart(store, {
      project,
      message: "Fix it",
      workspaceId: null,
      uuid: uuids(),
      now: 0,
    });
    const refused = ports(store, {
      connect: async () => {
        throw new Error("Could not pair with the clone: refused");
      },
    });
    expect(await runSavedOrbitThreadStart(start.id, refused.ports)).toBeNull();
    const stopped = store.starts()[0]!;
    expect(orbitThreadStartRow(stopped)).toEqual({
      stage: "stopped",
      label: "Stopped",
      detail: "Could not pair with the clone: refused",
      rows: null,
      notes: [],
      canRetry: true,
    });
    // A stopped start does not run again on its own.
    expect(await runSavedOrbitThreadStart(start.id, ports(store).ports)).toBeNull();

    // Retry drops the old error's code too, so a later failure is never read as a taken name.
    store.save({ ...stopped, errorCode: "instance.name_taken" });
    retryOrbitThreadStart(start.id, store);
    expect(orbitThreadStartRow(store.starts()[0]!).stage).toBe("pairing");
    expect(store.starts()[0]!.errorCode).toBeNull();
    dismissOrbitThreadStart(start.id, store);
    expect(store.starts()).toEqual([]);
  });

  it("puts each key on disk before the Gateway call that uses it", async () => {
    const file: { text: string | null } = { text: null };
    // The write lands a tick after it starts, as a file write does; a call that does not wait
    // for it sees the old file.
    const slow: OrbitThreadStartStorage = {
      load: async () => file.text,
      save: async (text) => {
        await Promise.resolve();
        file.text = text;
      },
    };
    const store = createOrbitThreadStartStore(slow);
    await store.load();
    const start = beginOrbitThreadStart(store, {
      project,
      message: "Fix it",
      workspaceId: null,
      uuid: uuids(),
      now: 0,
    });
    const onDisk: string[] = [];
    const run = ports(store);
    const gatewayCalls = run.ports.gateway;
    run.ports = {
      ...run.ports,
      gateway: {
        ...gatewayCalls,
        createThreadInstance: async (...args) => {
          onDisk.push(
            `create key saved: ${file.text?.includes('"createKey":"conn-thread-start') ?? false}`,
          );
          return gatewayCalls.createThreadInstance(...args);
        },
        startPairing: async (...args) => {
          onDisk.push(
            `pairing key saved: ${file.text?.includes('"pairingKey":"conn-thread-start') ?? false}`,
          );
          return gatewayCalls.startPairing(...args);
        },
      },
    };
    expect(await runSavedOrbitThreadStart(start.id, run.ports)).not.toBeNull();
    expect(onDisk).toEqual(["create key saved: true", "pairing key saved: true"]);
  });

  it("stops the start when the phone cannot save a step", async () => {
    const store = createOrbitThreadStartStore({
      load: async () => null,
      save: async () => {
        throw new Error("disk full");
      },
    });
    const start = beginOrbitThreadStart(store, {
      project,
      message: "Fix it",
      workspaceId: null,
      uuid: uuids(),
      now: 0,
    });
    const run = ports(store);
    expect(await runSavedOrbitThreadStart(start.id, run.ports)).toBeNull();
    expect(run.calls).toEqual([]);
    expect(store.starts()[0]!.error).toBe("Conn could not save the thread start on this phone.");
  });

  it("maps each saved step to its stage", () => {
    const start = newOrbitThreadStart({
      id: "s",
      project,
      message: "Hi",
      suffix: "abc",
      threadId: "t",
      messageId: "m",
      commandId: "c",
      now: 0,
    });
    expect(orbitThreadStartRow(start).label).toBe("Creating the clone…");
    expect(orbitThreadStartRow({ ...start, environmentId: "e" }).label).toBe("Pairing…");
    expect(orbitThreadStartRow({ ...start, environmentId: "e", connected: true }).label).toBe(
      "Sending the first message…",
    );
  });

  it("keeps starts added before the file loaded and drops rows without a launch command id", async () => {
    const saved = JSON.stringify([
      { id: "old", commandId: "c", threadId: "t", projectId: 1 },
      { id: "legacy", threadId: "t", projectId: 1 },
    ]);
    const { file, storage } = memoryFile(saved);
    const store = createOrbitThreadStartStore(storage);
    beginOrbitThreadStart(store, {
      project,
      message: "x",
      workspaceId: null,
      uuid: uuids(),
      now: 0,
    });
    await store.load();
    await store.flush();
    expect(store.starts().map((start) => start.id)).toEqual(["old", "id-1"]);
    // The write made before the load must not drop the saved start.
    expect(parseOrbitThreadStarts(file.text).map((start) => start.id)).toEqual(["old", "id-1"]);
  });

  it("returns past Choose project and the new-thread draft that opened it", () => {
    const home = { key: "home", name: "Home" };
    const picker = { key: "picker", name: "NewTaskProject" };
    const orbit = { key: "orbit", name: "NewOrbitThread" };
    const stack = (...routes: Array<{ key: string; name: string; params?: object }>) => ({
      index: routes.length - 1,
      routes,
    });
    // New chat opens a draft without a project, which opens Choose project; the empty draft
    // closes itself on focus, so the start returns to Home.
    const emptyDraft = { key: "draft", name: "Thread", params: { draft: {} } };
    expect(orbitStartReturn(stack(home, emptyDraft, picker, orbit))).toEqual({
      back: 3,
      returnRouteKey: "home",
    });
    // A draft with a project, opened from a thread page, returns to that thread page.
    const thread = { key: "thread-x", name: "Thread", params: { threadId: "x" } };
    const draft = { key: "draft", name: "Thread", params: { draft: { projectId: "p" } } };
    expect(orbitStartReturn(stack(home, thread, draft, picker, orbit))).toEqual({
      back: 3,
      returnRouteKey: "thread-x",
    });
    expect(orbitStartReturn(stack(home, picker, orbit))).toEqual({
      back: 2,
      returnRouteKey: "home",
    });
    // A direct new/orbit link.
    expect(orbitStartReturn(stack(home, orbit))).toEqual({ back: 1, returnRouteKey: "home" });
  });
});

describe("the create's completion on the phone (same answers as the desktop)", () => {
  /** A Gateway whose create admits completion 106; `completion` answers its reads in turn. */
  function withCompletion(store: MobileOrbitThreadStartPorts["store"], reads: unknown[]) {
    const run = ports(store);
    const base = run.ports.gateway;
    const completeCalls: string[] = [];
    let read = 0;
    run.ports = {
      ...run.ports,
      gateway: {
        ...base,
        operation: async (id: number) =>
          id === 106
            ? ({
                id,
                kind: "instance.complete",
                targetId: 41,
                pollAfterSeconds: 0,
                ...(reads[Math.min(read++, reads.length - 1)] as object),
              } as OrbitGatewayOperation)
            : id === 100
              ? { ...(await base.operation(id)), completionOperationId: 106 }
              : base.operation(id),
        completeInstance: async (instanceId: number, key: string) => {
          completeCalls.push(`complete ${instanceId} ${key}`);
          return {
            id: 107,
            kind: "instance.complete",
            targetId: 41,
            status: "running",
            errorCode: null,
            pollAfterSeconds: 0,
          } as OrbitGatewayOperation;
        },
      } as OrbitGatewayClient,
    };
    return { ...run, completeCalls };
  }

  async function sentStart(reads: unknown[]) {
    const store = createOrbitThreadStartStore(memoryFile().storage);
    await store.load();
    const start = beginOrbitThreadStart(store, {
      project,
      message: "Fix it",
      workspaceId: null,
      uuid: uuids(),
      now: 0,
    });
    const run = withCompletion(store, reads);
    expect(await runSavedOrbitThreadStart(start.id, run.ports)).not.toBeNull();
    // The runner's pass after the send marks the start as followed.
    expect(orbitSentStartStep(store.starts()[0]!)).toBe("mark");
    await runSentOrbitThreadStart(store.starts()[0]!, run.ports);
    return { store, start, run };
  }

  const workspaceFailed = {
    status: "failed",
    errorCode: "instance.create_workspace_failed",
    error: { code: "instance.create_workspace_failed", detail: "composer exit 1" },
    recoveryRetryable: true,
    steps: [
      {
        name: "clone-services",
        job: "complete",
        status: "failed",
        startedAt: null,
        finishedAt: null,
      },
    ],
  };

  it("keeps the start after the send, shows the running rows, and lets it go on success", async () => {
    const { store, start, run } = await sentStart([
      { status: "running", errorCode: null },
      { status: "succeeded", errorCode: null },
    ]);
    const kept = store.starts()[0]!;
    expect(kept).toMatchObject({ completionOperationId: 106, pendingThread: true });
    // A sent start leaves its Instance to the sync, so a removed one is cleaned up.
    expect(heldOrbitInstanceIds(store)).toEqual([]);
    const row = orbitThreadStartRow(kept);
    expect(row.stage).toBe("setup");
    expect(row.rows?.map((entry) => `${entry.label}:${entry.status}`)).toContain(
      "Publish the address:running",
    );
    expect(orbitCompletionSettled(kept)).toBe(false);

    await followSavedOrbitCompletion(start.id, run.ports);
    expect(orbitCompletionSettled(store.starts()[0]!)).toBe(true);
  });

  it("a failure shows the desktop's title, message, failed row, Retry and Dismiss", async () => {
    const { store, start, run } = await sentStart([workspaceFailed]);
    await followSavedOrbitCompletion(start.id, run.ports);
    const failed = store.starts()[0]!;
    const row = orbitThreadStartRow(failed);
    expect(row).toMatchObject({
      stage: "setupFailed",
      label: "Instance setup failed",
      detail: "Orbit could not set up the workspace.",
      notes: [
        "instance.create_workspace_failed · composer exit 1",
        "The Instance stays; remove it in Orbit.",
      ],
      canRetry: true,
    });
    expect(row.rows?.find((entry) => entry.id === "address")?.status).toBe("failed");
    expect(failed.error).toBeNull();
    expect(failed.connected).toBe(true);

    // Retry saves a new key; the runner sends it and follows the new Operation.
    expect(retrySavedOrbitCompletion(start.id, run.ports)).toBe(true);
    expect(orbitThreadStartRow(store.starts()[0]!).stage).toBe("setup");
    await followSavedOrbitCompletion(start.id, run.ports);
    expect(run.completeCalls).toHaveLength(1);
    expect(run.completeCalls[0]).toMatch(/^complete 41 conn-thread-start:.*:complete:/);
    expect(store.starts()[0]!.completionOperationId).toBe(107);

    dismissOrbitThreadStart(start.id, store);
    expect(store.starts()).toEqual([]);
  });

  it("Q4: a cancel outside a removal is titled Instance setup cancelled, with Retry", async () => {
    const { store, start, run } = await sentStart([
      { status: "cancelled", errorCode: "operation.cancelled", recoveryRetryable: true },
    ]);
    await followSavedOrbitCompletion(start.id, run.ports);
    expect(orbitThreadStartRow(store.starts()[0]!)).toMatchObject({
      stage: "setupFailed",
      label: "Instance setup cancelled",
      detail: "operation.cancelled",
      canRetry: true,
    });
  });

  it("Q3: a removal's cancel shows nothing new, and the row goes", async () => {
    const { store, start, run } = await sentStart([
      { status: "cancelled", errorCode: "operation.cancelled", recoveryRetryable: false },
    ]);
    await followSavedOrbitCompletion(start.id, run.ports);
    expect(orbitCompletionSettled(store.starts()[0]!)).toBe(true);
  });

  it("Q7: a process that did not start says …then retry, also without requires", async () => {
    const { store, start, run } = await sentStart([
      {
        status: "failed",
        errorCode: "instance.container_process_inactive",
        processFailureUnit: "conn-web.service",
        recoveryRetryable: true,
      },
    ]);
    await followSavedOrbitCompletion(start.id, run.ports);
    expect(orbitThreadStartRow(store.starts()[0]!).detail).toBe(
      "A process of this Project did not start: conn-web.service. Change or remove this process in the Project's Orbit settings, then retry.",
    );
  });

  it("a sent start saved without the follow mark (a quit between two writes) is marked, then followed", async () => {
    const { store, start, run } = await sentStart([workspaceFailed]);
    store.save({ ...store.starts()[0]!, pendingThread: false });
    await runSentOrbitThreadStart(store.starts()[0]!, run.ports);
    expect(store.starts()[0]!.pendingThread).toBe(true);
    expect(orbitSentStartStep(store.starts()[0]!)).toBe("follow");
    await runSentOrbitThreadStart(store.starts()[0]!, run.ports);
    expect(orbitThreadStartRow(store.starts()[0]!).stage).toBe("setupFailed");
    expect(start.id).toBe(store.starts()[0]!.id);
  });

  it("after a restart, sends an unanswered Retry again under its saved key", async () => {
    const { store, start, run } = await sentStart([workspaceFailed]);
    await followSavedOrbitCompletion(start.id, run.ports);
    retrySavedOrbitCompletion(start.id, run.ports);
    const key = store.starts()[0]!.completionKey;
    // As read back from the file after a restart: the key, no Operation yet.
    const [reloaded] = parseOrbitThreadStarts(JSON.stringify(store.starts()));
    const after = createOrbitThreadStartStore(memoryFile(JSON.stringify([reloaded])).storage);
    await after.load();
    await runSentOrbitThreadStart(after.starts()[0]!, { ...run.ports, store: after });
    expect(run.completeCalls).toEqual([`complete 41 ${key}`]);
    expect(after.starts()[0]!.completionOperationId).toBe(107);
  });

  it("a follow that stops quietly starts again after a wait", async () => {
    const { store, start, run } = await sentStart([{ status: "running", errorCode: null }]);
    let reads = 0;
    const waits: number[] = [];
    const base = run.ports.gateway;
    const flaky = {
      ...run.ports,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
      // Each read fails as a refused read (404); the third pass sees the completion succeed.
      now: () => reads * 100_000,
      gateway: {
        ...base,
        operation: async (id: number) => {
          reads += 1;
          if (reads < 3) {
            const { OrbitGatewayError } = await import("@t3tools/client-runtime/orbit-gateway");
            throw new OrbitGatewayError({
              code: "operation.not_found",
              message: "no",
              status: 404,
              details: {},
            });
          }
          return {
            id,
            kind: "instance.complete",
            targetId: 41,
            status: "succeeded",
            errorCode: null,
            pollAfterSeconds: null,
          } as OrbitGatewayOperation;
        },
      } as OrbitGatewayClient,
    };
    await followSavedOrbitCompletion(start.id, flaky);
    expect(waits.filter((ms) => ms === 30_000)).toHaveLength(2);
    expect(orbitSentStartStep(store.starts()[0]!)).toBe("drop");
  });

  it("an older Gateway without a completion: the start goes after the send, as before", () => {
    const start = newOrbitThreadStart({
      id: "s",
      project,
      message: "Hi",
      suffix: "abc",
      threadId: "t",
      messageId: "m",
      commandId: "c",
      now: 0,
    });
    expect(orbitCompletionSettled({ ...start, sentAt: 5 })).toBe(true);
    expect(orbitCompletionSettled(start)).toBe(false);
  });
});
