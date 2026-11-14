import { describe, expect, it } from "vite-plus/test";

import {
  ORBIT_CONTAINER_PROCESS_INACTIVE,
  ORBIT_RECOVERY_REQUIRES_PROCESS_DEFINITION,
  OrbitGatewayError,
  type OrbitGatewayBranchSelection,
  type OrbitGatewayClient,
  type OrbitGatewayEnvironment,
  type OrbitGatewayOperation,
} from "./client.ts";
import {
  newOrbitThreadStart,
  orbitThreadStartHasNoMessage,
  orbitThreadInstanceName,
  orbitThreadStartCanRetry,
  orbitThreadStartCreatedInstance,
  readOrbitThreadStarts,
  retryOrbitThreadStartRecord,
  runOrbitThreadStart,
  type OrbitThreadStart,
} from "./threadStart.ts";

const project = { id: 3, slug: "mealou", name: "Mealou", nodeId: 7, nodeName: "beast" };

function op(
  id: number,
  targetId: number,
  status: OrbitGatewayOperation["status"],
  errorCode: string | null = null,
): OrbitGatewayOperation {
  return { id, kind: "x", status, targetId, errorCode, pollAfterSeconds: 2 };
}

function server(instanceId: number, powerState: "running" | "stopped" = "running") {
  return {
    environmentId: `env-${instanceId}`,
    label: "mealou / clone",
    url: "http://10.44.0.7:3800",
    serverVersion: null,
    registeredBy: "beast",
    registeredAt: "2026-11-10T08:00:00+00:00",
    status: "registered",
    instanceId,
    powerState,
    projectId: null,
    projectName: null,
    projectSlug: null,
    instanceName: null,
    nodeName: null,
    instanceUrl: null,
  } satisfies OrbitGatewayEnvironment;
}

/** A Gateway whose Operations answer from scripted status lists, and that records every call. */
function gateway(script: {
  readonly create?: ReadonlyArray<OrbitGatewayOperation["status"]>;
  readonly pairing?: ReadonlyArray<OrbitGatewayOperation["status"]>;
  readonly readPairing?: () => Promise<{ pairingUrl: string }>;
  readonly servers?: ReadonlyArray<OrbitGatewayEnvironment>;
  /** Answers each admission's first tries with these HTTP statuses (0: no answer), then admits. */
  readonly createLost?: ReadonlyArray<number | OrbitGatewayError>;
  readonly pairingLost?: ReadonlyArray<number>;
  /** The succeeded create Operation's result. */
  readonly createResult?: Record<string, unknown>;
  /** Parsed fields of the succeeded create, such as its completion (release 2030). */
  readonly createExtra?: Partial<OrbitGatewayOperation>;
  /** Orbit's `error.detail` on a failed Operation. */
  readonly failedDetail?: string;
  /** The failed create's error code and its `result.process_failure.unit`. */
  readonly failedCode?: string;
  readonly failedUnit?: string;
  /** The failed create's `result.recovery.requires`. */
  readonly failedRequires?: string;
  /** Answers each name check with a reason (null: available), or throws for a failed check. */
  readonly nameCheck?: (name: string) => string | null;
  /** The cancel of an Operation fails with this error. */
  readonly cancelFails?: OrbitGatewayError;
}) {
  const calls: string[] = [];
  const keys: string[] = [];
  /** The branch argument of each create, as sent. */
  const branches: unknown[] = [];
  const createLost = [...(script.createLost ?? [])];
  const pairingLost = [...(script.pairingLost ?? [])];
  /** A bare status is a proxy's answer without the Gateway's error envelope. */
  const lose = (statuses: Array<number | OrbitGatewayError>) => {
    const status = statuses.shift();
    if (status === undefined) return;
    if (typeof status !== "number") throw status;
    throw new OrbitGatewayError({
      code: "gateway.request_failed",
      message: `lost ${status}`,
      status,
      details: {},
    });
  };
  const statuses = new Map<number, OrbitGatewayOperation["status"][]>([
    [100, [...(script.create ?? ["running", "succeeded"])]],
    [200, [...(script.pairing ?? ["queued", "succeeded"])]],
  ]);
  const nameCheck = script.nameCheck;
  const client = {
    ...(nameCheck && {
      checkInstanceName: async (projectId: number, name: string) => {
        calls.push(`check ${projectId} ${name}`);
        const reason = nameCheck(name);
        return { name, available: reason === null, reason, domain: null };
      },
    }),
    createThreadInstance: async (
      projectId: number,
      name: string,
      key: string,
      branch?: unknown,
    ) => {
      calls.push(`create ${projectId} ${name}`);
      keys.push(key);
      branches.push(branch ?? null);
      // The Gateway admits it even when the answer is lost.
      statuses.set(100, [...(script.create ?? ["running", "succeeded"])]);
      lose(createLost);
      return op(100, 41, "queued");
    },
    operation: async (id: number) => {
      calls.push(`operation ${id}`);
      const queue = statuses.get(id)!;
      const status = queue.length > 1 ? queue.shift()! : queue[0]!;
      const read = op(
        id,
        id === 100 ? 41 : 9,
        status,
        status === "failed" ? (script.failedCode ?? "instance.t3_unready") : null,
      );
      if (status === "failed" && script.failedUnit) {
        return {
          ...read,
          processFailureUnit: script.failedUnit,
          ...(script.failedRequires ? { recoveryRequires: script.failedRequires } : {}),
        };
      }
      if (status === "failed" && script.failedDetail) {
        return {
          ...read,
          error: { code: read.errorCode, message: null, detail: script.failedDetail },
        };
      }
      return id === 100 && status === "succeeded" && (script.createResult || script.createExtra)
        ? {
            ...read,
            ...(script.createResult ? { result: script.createResult } : {}),
            ...script.createExtra,
          }
        : read;
    },
    cancelOperation: async (id: number) => {
      calls.push(`cancel ${id}`);
      if (script.cancelFails) throw script.cancelFails;
      return op(id, 41, "running");
    },
    environments: async () => {
      calls.push("environments");
      return script.servers ?? [server(41)];
    },
    startPairing: async (environmentId: string, key: string) => {
      calls.push(`pair ${environmentId}`);
      keys.push(key);
      lose(pairingLost);
      return op(200, 9, "queued");
    },
    readPairing: async (environmentId: string, pairingId: number) => {
      calls.push(`read ${environmentId} ${pairingId}`);
      return script.readPairing
        ? { environmentId, expiresAt: "", ...(await script.readPairing()) }
        : { environmentId, pairingUrl: "http://10.44.0.7:3800/pair#token=t", expiresAt: "" };
    },
  } as unknown as OrbitGatewayClient;
  return { client, calls, keys, branches };
}

function ports(
  client: OrbitGatewayClient,
  options: { saved?: boolean; sendFails?: boolean; stopped?: () => boolean } = {},
) {
  const saves: OrbitThreadStart[] = [];
  const connected: string[] = [];
  const sent: string[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  return {
    saves,
    connected,
    sent,
    sleeps,
    ports: {
      client,
      save: (start: OrbitThreadStart) => saves.push(start),
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      stopped: options.stopped ?? (() => false),
      isSaved: () => options.saved ?? false,
      connect: async (_environmentId: string, url: string) => {
        connected.push(url);
      },
      send: async (start: OrbitThreadStart & { environmentId: string }) => {
        if (options.sendFails) throw new Error("The clone's workspace project did not appear.");
        sent.push(`${start.environmentId} ${start.threadId} ${start.message}`);
      },
    },
  };
}

const fresh = () =>
  newOrbitThreadStart({
    id: "s1",
    project,
    message: "Fix the login bug on iOS!",
    suffix: "k3j9",
    threadId: "thread-1",
    messageId: "message-1",
    commandId: "command-1",
    now: 0,
  });

describe("orbitThreadInstanceName", () => {
  it("makes an Instance name from the first words of the message", () => {
    expect(orbitThreadInstanceName("Fix the login bug on iOS!", "k3j9")).toBe(
      "fix-the-login-bug-on-ios-k3j9",
    );
    expect(orbitThreadInstanceName("Één   café — naïve", "a1b2")).toBe("een-cafe-naive-a1b2");
    expect(orbitThreadInstanceName("!!!", "a1b2")).toBe("thread-a1b2");
    const long = orbitThreadInstanceName("a".repeat(80), "a1b2");
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  });
});

describe("readOrbitThreadStarts", () => {
  // As a build before version 2 saved it, mid-create, on a Mac or a phone.
  const v1Row = {
    id: "old-1",
    projectId: 3,
    projectSlug: "mealou",
    nodeName: "beast",
    instanceName: "fix-the-login-bug-k3j9",
    message: "Fix the login bug",
    threadId: "thread-old",
    messageId: "message-old",
    commandId: "command-old",
    createdAt: 1762848000000,
    workspaceId: null,
    createKey: "conn-thread-start:old-1:create:1762848000000",
    createOperationId: 100,
    instanceId: 41,
    environmentId: null,
    pairingKey: null,
    pairingOperationId: null,
    pairingId: null,
    pairingLinkRead: false,
    connected: false,
    error: null,
  };

  it("loads rows saved before version 2, and they resume where they stopped", async () => {
    const [start] = readOrbitThreadStarts(JSON.parse(JSON.stringify([v1Row])));
    expect(start).toEqual({
      ...v1Row,
      orbitInstanceKind: "new",
      modelSelection: null,
      runtimeMode: null,
      interactionMode: null,
      errorCode: null,
      createStartedAt: null,
      createFinishedAt: null,
      connectStartedAt: null,
      connectFinishedAt: null,
      agentStartedAt: null,
      sentAt: null,
      pendingThread: false,
      projectName: null,
      instanceDomainSuffix: null,
      modelFallback: null,
      branch: null,
      defaultBranch: null,
      errorDetails: null,
      errorDetail: null,
      errorProcessUnit: null,
      errorRecoveryRequires: null,
      resultBranch: null,
      resultBaseBranch: null,
      nameSuffix: null,
      createRows: null,
      cancelRequested: false,
      completionOperationId: null,
      completionKey: null,
      completionStatus: null,
      completionErrorCode: null,
      completionErrorDetail: null,
      completionProcessUnit: null,
      completionRequires: null,
      completionRetryable: false,
    });

    const { client, calls } = gateway({});
    const run = ports(client);
    expect(await runOrbitThreadStart(start!, run.ports)).toBe(true);
    expect(calls[0]).toBe("operation 100");
    expect(calls.some((call) => call.startsWith("create"))).toBe(false);
    expect(run.sent).toEqual(["env-41 thread-old Fix the login bug"]);
  });

  it("keeps version 2 fields, reads wrong-typed ones as missing, and drops rows it cannot resume", () => {
    const v2 = {
      ...v1Row,
      id: "new-1",
      orbitInstanceKind: "existing",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      createStartedAt: 5,
      branch: { mode: "existing", name: "feature/login" },
      defaultBranch: "main",
      errorDetails: { instance: { id: 42, name: "login" } },
      resultBranch: "feature/login",
      resultBaseBranch: null,
    };
    const odd = {
      ...v1Row,
      id: "odd-1",
      orbitInstanceKind: "later",
      modelSelection: { model: "" },
      runtimeMode: "yolo",
      interactionMode: 1,
      createStartedAt: "5",
      branch: { mode: "new" },
      defaultBranch: 3,
      errorDetails: ["x"],
    };
    const { commandId: _, ...noCommand } = v1Row;

    const starts = readOrbitThreadStarts([v2, odd, noCommand, null, "x"]);

    expect(starts.map((start) => start.id)).toEqual(["new-1", "odd-1"]);
    expect(starts[0]).toMatchObject({
      orbitInstanceKind: "existing",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      createStartedAt: 5,
      branch: { mode: "existing", name: "feature/login" },
      defaultBranch: "main",
      errorDetails: { instance: { id: 42, name: "login" } },
      resultBranch: "feature/login",
      resultBaseBranch: null,
    });
    expect(starts[1]).toMatchObject({
      orbitInstanceKind: "new",
      modelSelection: null,
      runtimeMode: null,
      interactionMode: null,
      createStartedAt: null,
      branch: null,
      defaultBranch: null,
      errorDetails: null,
    });
    expect(readOrbitThreadStarts({ starts: [] })).toEqual([]);
  });
});

describe("runOrbitThreadStart", () => {
  it("creates the clone, pairs with its server once and sends the first message there", async () => {
    const { client, calls } = gateway({});
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(true);

    expect(calls).toEqual([
      "create 3 fix-the-login-bug-on-ios-k3j9",
      "operation 100",
      "operation 100",
      "environments",
      "pair env-41",
      "operation 200",
      "operation 200",
      "read env-41 9",
    ]);
    expect(run.connected).toEqual(["http://10.44.0.7:3800/pair#token=t"]);
    expect(run.sent).toEqual(["env-41 thread-1 Fix the login bug on iOS!"]);
    expect(run.saves.at(-1)).toMatchObject({
      createOperationId: 100,
      instanceId: 41,
      environmentId: "env-41",
      pairingOperationId: null,
      connected: true,
      error: null,
      errorCode: null,
      createStartedAt: expect.any(Number),
      createFinishedAt: expect.any(Number),
      connectStartedAt: expect.any(Number),
      connectFinishedAt: expect.any(Number),
      agentStartedAt: expect.any(Number),
      sentAt: expect.any(Number),
    });
    // The create's rows are saved as the runner reads the Operation.
    expect(run.saves.at(-1)!.createRows?.register?.status).toBe("done");
  });

  describe("a start with no message (the palette's plus)", () => {
    const plusStart = () =>
      newOrbitThreadStart({
        id: "p1",
        project,
        message: "",
        suffix: "k3j9",
        threadId: "thread-p",
        messageId: "message-p",
        commandId: "command-p",
        now: 0,
        instanceName: "abc",
      });

    it("sends the same create as a first message, pairs once, and ends connected without sending", async () => {
      const { client, calls, branches } = gateway({});
      const run = ports(client);

      expect(orbitThreadStartHasNoMessage(plusStart())).toBe(true);
      expect(await runOrbitThreadStart(plusStart(), run.ports)).toBe(true);

      expect(calls.filter((call) => call.startsWith("create"))).toEqual(["create 3 abc"]);
      expect(branches).toEqual([null]);
      expect(run.connected).toHaveLength(1);
      expect(run.sent).toEqual([]);
      expect(run.saves.at(-1)).toMatchObject({
        environmentId: "env-41",
        connected: true,
        error: null,
        agentStartedAt: null,
        sentAt: null,
      });
    });

    it("resumes after a relaunch during the create without a second create, and again after it without any call", async () => {
      const { client, calls } = gateway({ create: ["running", "running", "succeeded"] });
      const first = ports(client, { stopped: () => calls.includes("operation 100") });
      // The app quits while the create runs: the start ends without an error.
      expect(await runOrbitThreadStart(plusStart(), first.ports)).toBe(false);
      const during = readOrbitThreadStarts(JSON.parse(JSON.stringify([first.saves.at(-1)])))[0]!;
      expect(during).toMatchObject({ createOperationId: 100, error: null });

      const second = ports(client);
      expect(await runOrbitThreadStart(during, second.ports)).toBe(true);
      expect(calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
      expect(calls.filter((call) => call.startsWith("pair"))).toHaveLength(1);
      expect(second.sent).toEqual([]);

      const after = readOrbitThreadStarts(JSON.parse(JSON.stringify([second.saves.at(-1)])))[0]!;
      const callsBefore = calls.length;
      const third = ports(client, { saved: true });
      expect(await runOrbitThreadStart(after, third.ports)).toBe(true);
      expect(calls.slice(callsBefore)).toEqual([]);
      expect(third.sent).toEqual([]);
    });
  });

  describe("Cancel while the create is admitted", () => {
    const cancelPorts = (client: OrbitGatewayClient, requested: () => boolean) => {
      const run = ports(client);
      const cancelled: string[] = [];
      return {
        run,
        cancelled,
        ports: { ...run.ports, cancelRequested: requested, cancelled: () => cancelled.push("x") },
      };
    };

    it("cancels the Operation Orbit admitted, then ends the start", async () => {
      const { client, calls } = gateway({});
      const cancel = cancelPorts(client, () => true);
      expect(await runOrbitThreadStart(fresh(), cancel.ports)).toBe(false);
      expect(calls).toEqual(["create 3 fix-the-login-bug-on-ios-k3j9", "cancel 100"]);
      expect(cancel.cancelled).toHaveLength(1);
      expect(cancel.run.saves.at(-1)!.error).toBeNull();
    });

    it("cancels a create it already follows once the request arrives", async () => {
      const { client, calls } = gateway({ create: ["running", "running", "succeeded"] });
      const cancel = cancelPorts(client, () => calls.includes("operation 100"));
      expect(await runOrbitThreadStart(fresh(), cancel.ports)).toBe(false);
      expect(calls).toEqual([
        "create 3 fix-the-login-bug-on-ios-k3j9",
        "operation 100",
        "cancel 100",
      ]);
      expect(cancel.cancelled).toHaveLength(1);
    });

    it("keeps the start with the kept Instance when the cancel fails", async () => {
      const { client } = gateway({
        cancelFails: new OrbitGatewayError({
          code: "operation.not_cancellable",
          message: "Too late to cancel.",
          status: 409,
          details: {},
        }),
      });
      const cancel = cancelPorts(client, () => true);
      expect(await runOrbitThreadStart(fresh(), cancel.ports)).toBe(false);
      expect(cancel.cancelled).toEqual([]);
      expect(cancel.run.saves.at(-1)).toMatchObject({
        instanceId: 41,
        createOperationId: 100,
        errorCode: "operation.not_cancellable",
        error: expect.stringContaining("could not cancel"),
      });
    });
  });

  it("starts in an existing Instance without a create, and pairs with it", async () => {
    const { client, calls } = gateway({});
    const run = ports(client);
    const start = newOrbitThreadStart({
      id: "s2",
      project,
      message: "Add a dark mode",
      suffix: "unused",
      threadId: "thread-2",
      messageId: "message-2",
      commandId: "command-2",
      now: 0,
      existing: { instanceId: 41, environmentId: "env-41", name: "dark-mode", nodeName: "shark" },
    });
    expect(start).toMatchObject({
      orbitInstanceKind: "existing",
      instanceName: "dark-mode",
      nodeName: "shark",
      instanceId: 41,
      environmentId: "env-41",
    });

    expect(await runOrbitThreadStart(start, run.ports)).toBe(true);

    expect(calls).toEqual(["pair env-41", "operation 200", "operation 200", "read env-41 9"]);
    expect(run.sent).toEqual(["env-41 thread-2 Add a dark mode"]);
    expect(run.saves.at(-1)).toMatchObject({ createStartedAt: null, createKey: null });
  });

  it("wakes an asleep existing Instance before it pairs, and leaves an awake one alone", async () => {
    const existing = (id: string) =>
      newOrbitThreadStart({
        id,
        project,
        message: "Add a dark mode",
        suffix: "unused",
        threadId: `thread-${id}`,
        messageId: `message-${id}`,
        commandId: `command-${id}`,
        now: 0,
        existing: { instanceId: 41, environmentId: "env-41", name: "dark-mode", nodeName: "shark" },
      });
    const woken: number[] = [];
    const wake = async (instanceId: number) => {
      woken.push(instanceId);
      return { kind: "awake" as const };
    };

    const asleep = gateway({ servers: [server(41, "stopped")] });
    const asleepRun = ports(asleep.client);
    expect(await runOrbitThreadStart(existing("s3"), { ...asleepRun.ports, wake })).toBe(true);
    expect(woken).toEqual([41]);
    expect(asleep.calls.slice(0, 2)).toEqual(["environments", "pair env-41"]);

    const awake = gateway({});
    const awakeRun = ports(awake.client);
    expect(await runOrbitThreadStart(existing("s4"), { ...awakeRun.ports, wake })).toBe(true);
    expect(woken).toEqual([41]);
  });

  it("keeps a taken name's code and drops its key, so a new name is created anew", async () => {
    const taken = new OrbitGatewayError({
      code: "instance.name_taken",
      message: "The name fix is taken.",
      status: 422,
      details: {},
    });
    const { client } = gateway({ createLost: [taken] });
    const start = { ...fresh(), instanceName: "fix" };

    const run = ports(client);
    expect(await runOrbitThreadStart(start, run.ports)).toBe(false);
    const stopped = run.saves.at(-1)!;
    expect(stopped).toMatchObject({
      error: "The name fix is taken.",
      errorCode: "instance.name_taken",
      createKey: null,
      createOperationId: null,
    });

    const retry = gateway({});
    const renamed = { ...stopped, instanceName: "fix-2", error: null };
    expect(await runOrbitThreadStart(renamed, ports(retry.client).ports)).toBe(true);
    expect(retry.calls[0]).toBe("create 3 fix-2");
  });

  describe("a name made from the message", () => {
    const longStart = () =>
      newOrbitThreadStart({
        id: "s9",
        project,
        suffix: "k3j9",
        now: 0,
        message: "Please refactor the checkout payment flow handlers",
        threadId: "thread-9",
        messageId: "message-9",
        commandId: "command-9",
      });
    const tooLong = (limit: number) => (name: string) =>
      name.length > limit ? "domain_invalid" : null;

    it("shortens the slug while Orbit says the address is too long, keeping the suffix", async () => {
      const { client, calls } = gateway({ nameCheck: tooLong(20) });
      const run = ports(client);

      expect(await runOrbitThreadStart(longStart(), run.ports)).toBe(true);

      expect(calls.slice(0, 4)).toEqual([
        "check 3 please-refactor-the-checkout-payment-flo-k3j9",
        "check 3 please-refactor-the-chec-k3j9",
        "check 3 please-refac-k3j9",
        "create 3 please-refac-k3j9",
      ]);
      expect(run.saves.at(-1)).toMatchObject({ instanceName: "please-refac-k3j9" });
    });

    it("checks only names it made, once per create attempt", async () => {
      const typed = gateway({ nameCheck: tooLong(20) });
      const start = newOrbitThreadStart({
        id: "s9",
        project,
        suffix: "k3j9",
        now: 0,
        instanceName: "my-own-long-name",
        message: "Please refactor the checkout payment flow handlers",
        threadId: "thread-9",
        messageId: "message-9",
        commandId: "command-9",
      });
      expect(await runOrbitThreadStart(start, ports(typed.client).ports)).toBe(true);
      expect(typed.calls[0]).toBe("create 3 my-own-long-name");

      const lost = gateway({ nameCheck: () => null, createLost: [0] });
      expect(await runOrbitThreadStart(longStart(), ports(lost.client).ports)).toBe(true);
      expect(lost.calls.filter((call) => call.startsWith("check"))).toHaveLength(1);

      // A repeat under the saved key keeps the name it already checked.
      const repeat = gateway({ nameCheck: tooLong(20) });
      const saved = { ...longStart(), instanceName: "saved-name", createKey: "create-saved" };
      expect(await runOrbitThreadStart(saved, ports(repeat.client).ports)).toBe(true);
      expect(repeat.calls.filter((call) => call.startsWith("check"))).toEqual([]);
      expect(repeat.calls[0]).toBe("create 3 saved-name");
    });

    it.each([
      ["no name fits", tooLong(5)],
      [
        "the check fails after Orbit refused a name",
        (name: string) => {
          if (name.length < 40) throw new Error("check failed");
          return "domain_invalid";
        },
      ],
    ])("stops without a create when %s", async (_case, nameCheck) => {
      const { client, calls } = gateway({ nameCheck });
      const run = ports(client);

      expect(await runOrbitThreadStart(longStart(), run.ports)).toBe(false);

      expect(calls.some((call) => call.startsWith("create"))).toBe(false);
      expect(run.saves.at(-1)).toMatchObject({
        error: "This name makes the address too long. Use a shorter name.",
        errorCode: "route.domain_invalid",
        createKey: null,
        instanceId: null,
      });
    });

    it("tries 40, 24 and 12 characters of slug, then thread", async () => {
      const { client, calls } = gateway({ nameCheck: tooLong(5) });
      await runOrbitThreadStart(longStart(), ports(client).ports);
      expect(calls).toEqual([
        "check 3 please-refactor-the-checkout-payment-flo-k3j9",
        "check 3 please-refactor-the-chec-k3j9",
        "check 3 please-refac-k3j9",
        "check 3 thread-k3j9",
      ]);
    });

    it("leaves the name to the create when the first check fails", async () => {
      const { client, calls } = gateway({
        nameCheck: () => {
          throw new Error("check failed");
        },
      });
      expect(await runOrbitThreadStart(longStart(), ports(client).ports)).toBe(true);
      expect(calls[1]).toBe("create 3 please-refactor-the-checkout-payment-flo-k3j9");
    });
  });

  it("shows the address text for a create refused as route.domain_invalid, and drops its key", async () => {
    const refused = new OrbitGatewayError({
      code: "route.domain_invalid",
      message: "The domain is invalid.",
      status: 422,
      details: {},
    });
    const { client } = gateway({ createLost: [refused] });
    const run = ports(client);

    expect(await runOrbitThreadStart({ ...fresh(), instanceName: "fix" }, run.ports)).toBe(false);
    expect(run.saves.at(-1)).toMatchObject({
      error: "This name makes the address too long. Use a shorter name.",
      errorCode: "route.domain_invalid",
      createKey: null,
      createOperationId: null,
      instanceId: null,
    });
  });

  it("resumes a saved start without a second create or pairing", async () => {
    const { client, calls } = gateway({});
    const run = ports(client);
    const saved: OrbitThreadStart = {
      ...fresh(),
      createOperationId: 100,
      instanceId: 41,
      environmentId: "env-41",
      pairingOperationId: 200,
      pairingId: 9,
    };

    expect(await runOrbitThreadStart(saved, run.ports)).toBe(true);

    expect(calls.filter((call) => call.startsWith("create") || call.startsWith("pair"))).toEqual(
      [],
    );
    expect(run.connected).toHaveLength(1);
  });

  it("pairs not at all when the device saved the server already", async () => {
    const { client, calls } = gateway({});
    const run = ports(client, { saved: true });

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(true);

    expect(calls.some((call) => call.startsWith("pair") || call.startsWith("read"))).toBe(false);
    expect(run.sent).toHaveLength(1);
  });

  it("stops on a failed create with Orbit's detail, and a retry creates the same name again", async () => {
    const { client, calls } = gateway({
      create: ["running", "failed"],
      failedDetail: "Argument list too long",
    });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    const stopped = run.saves.at(-1)!;
    expect(stopped).toMatchObject({
      createOperationId: null,
      error: expect.stringContaining("instance.t3_unready"),
      errorDetail: "Argument list too long",
    });

    expect(stopped.createKey).toBeNull();
    // The saved record keeps the detail across a reload.
    const [reloaded] = readOrbitThreadStarts(JSON.parse(JSON.stringify([stopped])));
    expect(reloaded!.errorDetail).toBe("Argument list too long");
    expect(retryOrbitThreadStartRecord(stopped).errorDetail).toBeNull();
    expect(
      retryOrbitThreadStartRecord({
        ...stopped,
        createRows: { container: { status: "failed", startedAt: 1, finishedAt: 2 } },
      }).createRows,
    ).toBeNull();

    const retry = gateway({});
    const retryRun = ports(retry.client);
    expect(await runOrbitThreadStart(stopped, retryRun.ports)).toBe(true);
    expect(retryRun.saves[0]!.errorDetail).toBeNull();
    expect(retry.calls[0]).toBe(`create 3 ${stopped.instanceName}`);
    expect(calls.filter((call) => call.startsWith("pair"))).toEqual([]);
  });

  it("keeps the process that did not stay up, offers no Retry for it, and clears it on a new attempt", async () => {
    const { client } = gateway({
      create: ["running", "failed"],
      failedCode: ORBIT_CONTAINER_PROCESS_INACTIVE,
      failedUnit: "conn-web.service",
    });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    const stopped = run.saves.at(-1)!;
    expect(stopped).toMatchObject({
      errorCode: ORBIT_CONTAINER_PROCESS_INACTIVE,
      errorProcessUnit: "conn-web.service",
    });
    const [reloaded] = readOrbitThreadStarts(JSON.parse(JSON.stringify([stopped])));
    expect(reloaded!.errorProcessUnit).toBe("conn-web.service");
    expect(reloaded!.errorRecoveryRequires).toBeNull();
    expect(orbitThreadStartCanRetry(reloaded!)).toBe(false);
    expect(retryOrbitThreadStartRecord(stopped).errorProcessUnit).toBeNull();

    const again = ports(gateway({}).client);
    expect(await runOrbitThreadStart(stopped, again.ports)).toBe(true);
    expect(again.saves[0]!.errorProcessUnit).toBeNull();
  });

  it("offers Retry for a process that did not stay up when Orbit retries with the current definitions", async () => {
    const { client } = gateway({
      create: ["running", "failed"],
      failedCode: ORBIT_CONTAINER_PROCESS_INACTIVE,
      failedUnit: "conn-web.service",
      failedRequires: ORBIT_RECOVERY_REQUIRES_PROCESS_DEFINITION,
    });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    const stopped = run.saves.at(-1)!;
    expect(stopped.errorRecoveryRequires).toBe(ORBIT_RECOVERY_REQUIRES_PROCESS_DEFINITION);
    const [reloaded] = readOrbitThreadStarts(JSON.parse(JSON.stringify([stopped])));
    expect(reloaded!.errorRecoveryRequires).toBe(ORBIT_RECOVERY_REQUIRES_PROCESS_DEFINITION);
    expect(orbitThreadStartCanRetry(reloaded!)).toBe(true);
    expect(retryOrbitThreadStartRecord(stopped).errorRecoveryRequires).toBeNull();

    const again = ports(gateway({}).client);
    expect(await runOrbitThreadStart(stopped, again.ports)).toBe(true);
    expect(again.saves[0]!.errorRecoveryRequires).toBeNull();
  });

  it("offers Retry for every other failed or cancelled create", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const run = ports(gateway({ create: ["running", status] }).client);
      expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
      const stopped = run.saves.at(-1)!;
      expect(stopped.errorProcessUnit).toBeNull();
      expect(stopped.errorRecoveryRequires).toBeNull();
      expect(orbitThreadStartCanRetry(stopped)).toBe(true);
    }
  });

  it("repeats a create whose answer was lost with the same name and key, and follows its Operation", async () => {
    const { client, calls, keys } = gateway({ createLost: [0, 502, 504] });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(true);

    expect(calls.filter((call) => call.startsWith("create"))).toEqual(
      Array(4).fill("create 3 fix-the-login-bug-on-ios-k3j9"),
    );
    expect(new Set(keys.slice(0, 4)).size).toBe(1);
    expect(keys[0]).toMatch(/^conn-thread-start:s1:create:/);
    expect(run.sleeps.slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(run.saves.at(-1)).toMatchObject({ createOperationId: 100, error: null });
  });

  it.each([
    [409, "lost 409"],
    [503, "lost 503"],
    [
      new OrbitGatewayError({
        code: "operation.kind_unavailable",
        message: "Conn is off.",
        status: 503,
        details: {},
      }),
      "Conn is off.",
    ],
    [
      new OrbitGatewayError({
        code: "database.server_command_failed",
        message: "The command failed.",
        status: 502,
        details: {},
      }),
      "The command failed.",
    ],
  ])("stops at once on a create the Gateway refused (%s)", async (answer, error) => {
    const { client, calls } = gateway({ createLost: [answer] });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);

    expect(calls).toEqual(["create 3 fix-the-login-bug-on-ios-k3j9"]);
    expect(run.saves.at(-1)).toMatchObject({ createOperationId: null, error });
  });

  it("ends a start dismissed while it repeats a lost create, without an error", async () => {
    let dismissed = false;
    const { client, calls } = gateway({ createLost: [0, 0, 0] });
    const run = ports(client, { stopped: () => dismissed });
    const sleep = run.ports.sleep;
    run.ports.sleep = async (ms) => {
      await sleep(ms);
      dismissed = true;
    };

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);

    expect(calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
    expect(run.saves.at(-1)?.error).toBeNull();
  });

  const busy = () =>
    new OrbitGatewayError({
      code: "operation.target_busy",
      message: "Another Operation owns this target.",
      status: 409,
      details: {},
    });

  it("repeats a create refused as busy with the same name and key, and follows the replayed Operation", async () => {
    const { client, calls, keys } = gateway({ createLost: [busy(), busy()] });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(true);

    expect(calls.filter((call) => call.startsWith("create"))).toEqual(
      Array(3).fill("create 3 fix-the-login-bug-on-ios-k3j9"),
    );
    expect(new Set(keys.slice(0, 3)).size).toBe(1);
    expect(run.sleeps.slice(0, 2)).toEqual([1000, 2000]);
    expect(run.saves.at(-1)).toMatchObject({
      createOperationId: 100,
      connected: true,
      error: null,
    });
  });

  it("stops a create that stays busy at its deadline, and keeps the key for Retry", async () => {
    const { client, keys } = gateway({ createLost: Array.from({ length: 500 }, busy) });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);

    expect(run.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(30 * 60_000);
    expect(run.sleeps.every((ms) => ms <= 15_000)).toBe(true);
    const stopped = run.saves.at(-1)!;
    expect(stopped).toMatchObject({
      createOperationId: null,
      createKey: keys[0],
      error: "Orbit is still creating this clone; press Retry in a minute.",
    });
  });

  it("ends a start dismissed while a busy create repeats, without an error", async () => {
    let dismissed = false;
    const { client, calls } = gateway({ createLost: [busy(), busy(), busy()] });
    const run = ports(client, { stopped: () => dismissed });
    const sleep = run.ports.sleep;
    run.ports.sleep = async (ms) => {
      await sleep(ms);
      dismissed = true;
    };

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);

    expect(calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
    expect(run.saves.every((start) => start.error === null)).toBe(true);
  });

  it("keeps the create's key when its answers stay lost, so Retry gets the Operation the Gateway admitted", async () => {
    const { client, keys } = gateway({ createLost: Array(500).fill(0) });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    const stopped = run.saves.at(-1)!;
    expect(run.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(30 * 60_000);
    expect(stopped).toMatchObject({ createOperationId: null, error: "lost 0" });
    expect(stopped.createKey).toBe(keys[0]);

    const retry = gateway({});
    expect(await runOrbitThreadStart(stopped, ports(retry.client).ports)).toBe(true);
    expect(retry.calls[0]).toBe(`create 3 ${stopped.instanceName}`);
    expect(retry.keys[0]).toBe(stopped.createKey);
    expect(retry.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
  });

  it("resumes on Retry a start that an older build stopped when the create timed out", async () => {
    const {
      createKey: _createKey,
      pairingKey: _pairingKey,
      ...older
    } = {
      ...fresh(),
      error: "The Orbit Gateway did not answer in time.",
    };
    const { client, calls, keys } = gateway({});
    const run = ports(client);

    expect(await runOrbitThreadStart(older, run.ports)).toBe(true);

    // The Gateway resumes the device's own clone by its name and answers its Operation.
    expect(calls.slice(0, 2)).toEqual(["create 3 fix-the-login-bug-on-ios-k3j9", "operation 100"]);
    expect(calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
    expect(run.saves[0]?.createKey).toBe(keys[0]);
    expect(run.saves.at(-1)).toMatchObject({ createOperationId: 100, instanceId: 41, error: null });
  });

  it("repeats a pairing whose answer was lost with the same key", async () => {
    const { client, calls, keys } = gateway({ pairingLost: [0] });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(true);

    expect(calls.filter((call) => call.startsWith("pair"))).toEqual(["pair env-41", "pair env-41"]);
    expect(keys.slice(1)).toEqual([keys[1], keys[1]]);
    expect(keys[1]).toMatch(/^conn-thread-start:s1:pairing:/);
    expect(run.saves.at(-1)).toMatchObject({ pairingKey: null, connected: true });
  });

  it("stops without a second pairing when the link was already read", async () => {
    const { client, calls } = gateway({
      readPairing: async () => {
        throw new OrbitGatewayError({
          code: "http.409",
          message: "Conflict",
          status: 409,
          details: {},
        });
      },
    });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);

    expect(calls.filter((call) => call.startsWith("pair"))).toEqual(["pair env-41"]);
    expect(run.connected).toEqual([]);
    expect(run.saves.at(-1)).toMatchObject({
      environmentId: "env-41",
      pairingOperationId: null,
      connected: false,
      error: "The pairing link was already used or expired.",
    });
  });

  it("drops a pairing whose link was read when the connect fails, so a retry pairs anew", async () => {
    const { client } = gateway({});
    const run = ports(client);
    run.ports.connect = async () => {
      throw new Error("The clone did not answer.");
    };

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);

    expect(run.saves.at(-1)).toMatchObject({
      environmentId: "env-41",
      pairingOperationId: null,
      pairingId: null,
      pairingLinkRead: false,
      connected: false,
      error: "The clone did not answer.",
    });
  });

  it("waits for Retry when a reload comes after the link was read and before the server was saved", async () => {
    const { client, calls } = gateway({});
    const run = ports(client);
    const reloaded: OrbitThreadStart = {
      ...fresh(),
      createOperationId: 100,
      instanceId: 41,
      environmentId: "env-41",
      pairingLinkRead: true,
    };

    expect(await runOrbitThreadStart(reloaded, run.ports)).toBe(false);
    const stopped = run.saves.at(-1)!;
    expect(calls).toEqual([]);
    expect(stopped).toMatchObject({
      pairingLinkRead: false,
      error: expect.stringContaining("link"),
    });

    const retry = gateway({});
    expect(await runOrbitThreadStart(stopped, ports(retry.client).ports)).toBe(true);
    expect(retry.calls.filter((call) => call.startsWith("pair"))).toEqual(["pair env-41"]);
  });

  it("stops a pairing that does not finish within 60 s, and keeps a slow create for the retry", async () => {
    const pairing = gateway({ pairing: ["running"] });
    const run = ports(pairing.client);
    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    expect(run.saves.at(-1)).toMatchObject({
      pairingOperationId: null,
      error: expect.stringContaining("operation.timeout"),
    });
    // One 2 s poll of the create, then the pairing's 60 s.
    expect(run.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(62_000);

    const create = gateway({ create: ["running"] });
    const read = create.client.operation;
    const slow = ports({
      ...create.client,
      operation: async (id: number) => ({ ...(await read(id)), currentStep: "clone-workspace" }),
    } as OrbitGatewayClient);
    expect(await runOrbitThreadStart(fresh(), slow.ports)).toBe(false);
    const stopped = slow.saves.at(-1)!;
    expect(stopped).toMatchObject({ createOperationId: 100, environmentId: null });
    // The row that ran turns red with the time the create stopped; the address did not start.
    expect(stopped.createRows?.t3).toMatchObject({
      status: "failed",
      finishedAt: slow.ports.now(),
    });
    expect(stopped.createRows?.address?.status).toBe("pending");
  });

  it("never polls faster than every 0.5 s", async () => {
    const { client } = gateway({});
    const operation = client.operation;
    const fast = {
      ...client,
      operation: async (id: number) => ({ ...(await operation(id)), pollAfterSeconds: 0 }),
    } as OrbitGatewayClient;
    const run = ports(fast);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(true);
    expect(run.sleeps.every((ms) => ms >= 500)).toBe(true);
  });

  it("ends a dismissed start at the next step without saving it", async () => {
    const { client, calls } = gateway({ create: ["running", "running", "succeeded"] });
    let dismissed = false;
    const run = ports(client, { stopped: () => dismissed });
    const original = run.ports.sleep;
    run.ports.sleep = async (ms: number) => {
      dismissed = true;
      await original(ms);
    };

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    expect(calls.filter((call) => call.startsWith("operation"))).toEqual(["operation 100"]);
    expect(run.saves.every((start) => start.error === null)).toBe(true);
  });

  it("pairs anew on Retry when reading the link fails, since the Gateway may have handed it out", async () => {
    const { client } = gateway({
      readPairing: async () => {
        throw new OrbitGatewayError({
          code: "http.502",
          message: "Bad gateway",
          status: 502,
          details: {},
        });
      },
    });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    expect(run.saves.at(-1)).toMatchObject({ pairingOperationId: null, pairingId: null });
  });

  it("ends without an error when it is stopped mid-step, so it resumes later", async () => {
    const { client } = gateway({});
    let stopped = false;
    const run = ports(client, { stopped: () => stopped });
    run.ports.send = async () => {
      stopped = true;
      throw new Error("The thread start was stopped.");
    };

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    expect(run.saves.every((start) => start.error === null)).toBe(true);
  });

  it("stops after a minute of failed Operation reads", async () => {
    const { client } = gateway({});
    const down = {
      ...client,
      operation: async () => {
        throw new OrbitGatewayError({
          code: "gateway.unreachable",
          message: "down",
          status: 0,
          details: {},
        });
      },
    } as OrbitGatewayClient;
    const run = ports(down);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    expect(run.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(60_000);
    expect(run.saves.at(-1)).toMatchObject({ createOperationId: 100, error: "down" });
  });

  it("does not pair with a server whose registration expired", async () => {
    const { client, calls } = gateway({
      servers: [{ ...server(41), status: "session_expired" }],
    });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    expect(calls.some((call) => call.startsWith("pair"))).toBe(false);
    expect(run.saves.at(-1)?.error).toContain("expired");
  });

  it("rides out a short Gateway outage while it follows the create", async () => {
    const { client, calls } = gateway({});
    const operation = client.operation;
    let failures = 2;
    const flaky = {
      ...client,
      operation: async (id: number) => {
        if (id === 100 && failures-- > 0) {
          throw new OrbitGatewayError({
            code: "gateway.unreachable",
            message: "down",
            status: 0,
            details: {},
          });
        }
        return operation(id);
      },
    } as OrbitGatewayClient;
    const run = ports(flaky);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(true);
    expect(calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
  });

  it("keeps the pairing when the send fails, so a retry only sends", async () => {
    const { client } = gateway({});
    const run = ports(client, { sendFails: true });

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    const stopped = run.saves.at(-1)!;
    expect(stopped).toMatchObject({ connected: true, error: expect.stringContaining("workspace") });

    const retry = gateway({});
    const again = ports(retry.client);
    expect(await runOrbitThreadStart(stopped, again.ports)).toBe(true);
    expect(retry.calls).toEqual([]);
    expect(again.sent).toHaveLength(1);
  });

  it("stops on a clone whose container is asleep when Conn cannot wake it", async () => {
    const { client } = gateway({ servers: [server(41, "stopped")] });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);

    expect(run.saves.at(-1)).toMatchObject({
      environmentId: null,
      error: "The clone is asleep. Conn cannot wake it yet.",
    });
  });

  it("wakes an asleep clone once and goes on to pair with it", async () => {
    const { client, calls } = gateway({ servers: [server(41, "stopped")] });
    const run = ports(client);
    const woken: number[] = [];
    const wake = async (instanceId: number) => {
      woken.push(instanceId);
      return { kind: "awake" as const };
    };

    expect(await runOrbitThreadStart(fresh(), { ...run.ports, wake })).toBe(true);

    expect(woken).toEqual([41]);
    expect(calls).toContain("pair env-41");
    expect(run.sent).toHaveLength(1);
  });

  it("shows a failed wake, and keeps today's text on a Gateway without the wake route", async () => {
    const failed = gateway({ servers: [server(41, "stopped")] });
    const failedRun = ports(failed.client);
    const wakeFails = async () =>
      ({ kind: "failed", code: "instance.t3_unready", message: "T3 was slow." }) as const;
    expect(await runOrbitThreadStart(fresh(), { ...failedRun.ports, wake: wakeFails })).toBe(false);
    expect(failedRun.saves.at(-1)).toMatchObject({
      error: "Orbit could not wake the clone (instance.t3_unready).",
      errorCode: "instance.t3_unready",
    });
    expect(failed.calls).not.toContain("pair env-41");

    const older = gateway({ servers: [server(41, "stopped")] });
    const olderRun = ports(older.client);
    const unsupported = async () => ({ kind: "unsupported" }) as const;
    expect(await runOrbitThreadStart(fresh(), { ...olderRun.ports, wake: unsupported })).toBe(
      false,
    );
    expect(olderRun.saves.at(-1)).toMatchObject({
      error: "The clone is asleep. Conn cannot wake it yet.",
    });
  });

  it("re-stamps the create time on a new attempt after a taken name", async () => {
    const taken = new OrbitGatewayError({
      code: "instance.name_taken",
      message: "The name fix is taken.",
      status: 422,
      details: {},
    });
    const { client } = gateway({ createLost: [taken] });
    const run = ports(client);
    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    const failed = run.saves.at(-1)!;
    expect(failed.createStartedAt).toBe(0);

    // Change name: a new attempt later on the clock.
    const again = gateway({});
    const second = ports(again.client);
    const renamed = retryOrbitThreadStartRecord(failed, { instanceName: "fix-two" });
    expect(renamed).toMatchObject({ error: null, errorCode: null, createStartedAt: null });
    const later = { ...second.ports, now: () => 500 };
    expect(await runOrbitThreadStart(renamed, later)).toBe(true);
    expect(second.saves.at(-1)).toMatchObject({ createStartedAt: 500, instanceName: "fix-two" });
  });

  it("hands each read of the create Operation to the setup card", async () => {
    const { client } = gateway({});
    const run = ports(client);
    const reads: string[] = [];
    const observed = {
      ...run.ports,
      onCreateOperation: (operation: OrbitGatewayOperation) => reads.push(operation.status),
    };
    expect(await runOrbitThreadStart(fresh(), observed)).toBe(true);
    expect(reads).toEqual(["running", "succeeded"]);
  });

  it("saves what the send resolves with the sent start", async () => {
    const { client } = gateway({});
    const run = ports(client);
    const fallback = { modelFallback: { requestedModel: "opus", usedModel: "gpt-5" } };
    const withFallback = { ...run.ports, send: async () => fallback };
    expect(await runOrbitThreadStart(fresh(), withFallback)).toBe(true);
    expect(run.saves.at(-1)).toMatchObject({ ...fallback, sentAt: expect.any(Number) });
  });
});

describe("runOrbitThreadStart with a branch", () => {
  const onBranch = (branch: OrbitGatewayBranchSelection | null): OrbitThreadStart => ({
    ...fresh(),
    instanceName: "fix",
    branch,
    defaultBranch: "main",
  });
  const refusal = (code: string, status: number, details: Record<string, unknown> = {}) =>
    new OrbitGatewayError({ code, message: `refused ${code}`, status, details });

  it("sends the branch as saved, and none without a choice", async () => {
    for (const branch of [
      { mode: "new", from: "develop" },
      { mode: "existing", name: "feature/login" },
    ] as const) {
      const sent = gateway({});
      expect(await runOrbitThreadStart(onBranch(branch), ports(sent.client).ports)).toBe(true);
      expect(sent.branches).toEqual([branch]);
    }
    // No choice ("From main") sends none.
    const none = gateway({});
    expect(await runOrbitThreadStart(onBranch(null), ports(none.client).ports)).toBe(true);
    expect(none.branches).toEqual([null]);
  });

  it.each([
    ["branch.in_use", 409, { instance: { id: 42, name: "login" } }],
    ["branch.in_use", 409, {}],
    ["branch.not_found", 422, { field: "branch.from" }],
    ["branch.exists", 422, { field: "name", branch: "fix" }],
    ["source.head_unavailable", 502, {}],
    ["instance.placement_conflict", 409, {}],
    ["validation.failed", 422, { field: "branch.from" }],
  ])(
    "keeps an admission refusal %s with its details, made no Instance, and drops the key",
    async (code, status, details) => {
      const { client } = gateway({ createLost: [refusal(code, status, details)] });
      const run = ports(client);
      expect(await runOrbitThreadStart(onBranch({ mode: "new", from: "develop" }), run.ports)).toBe(
        false,
      );
      const stopped = run.saves.at(-1)!;
      expect(stopped).toMatchObject({
        errorCode: code,
        errorDetails: details,
        createKey: null,
        createOperationId: null,
        instanceId: null,
      });
      expect(orbitThreadStartCreatedInstance(stopped)).toBe(false);
    },
  );

  it("resends exactly the same branch on Retry after a refusal", async () => {
    const branch = { mode: "existing", name: "feature/login" } as const;
    const first = gateway({ createLost: [refusal("source.head_unavailable", 502)] });
    const run = ports(first.client);
    expect(await runOrbitThreadStart(onBranch(branch), run.ports)).toBe(false);
    const retried = retryOrbitThreadStartRecord(run.saves.at(-1)!);
    expect(retried).toMatchObject({ branch, errorCode: null, errorDetails: null });
    const second = gateway({});
    expect(await runOrbitThreadStart(retried, ports(second.client).ports)).toBe(true);
    expect([...first.branches, ...second.branches]).toEqual([branch, branch]);
  });

  it("keeps a failed create step's code with the Instance it made", async () => {
    const { client } = gateway({ create: ["running", "failed"] });
    const run = ports(client);
    expect(await runOrbitThreadStart(onBranch({ mode: "new", from: "develop" }), run.ports)).toBe(
      false,
    );
    expect(run.saves.at(-1)).toMatchObject({ errorCode: "instance.t3_unready", instanceId: 41 });
    expect(orbitThreadStartCreatedInstance(run.saves.at(-1)!)).toBe(true);
  });

  it("saves the branch and base from the create's result", async () => {
    const { client } = gateway({ createResult: { branch: "fix", base_branch: "develop" } });
    const run = ports(client);
    expect(await runOrbitThreadStart(onBranch({ mode: "new", from: "develop" }), run.ports)).toBe(
      true,
    );
    expect(run.saves.at(-1)).toMatchObject({ resultBranch: "fix", resultBaseBranch: "develop" });
    const plain = gateway({ createResult: { branch: "feature/login", base_branch: null } });
    const plainRun = ports(plain.client);
    expect(await runOrbitThreadStart(fresh(), plainRun.ports)).toBe(true);
    expect(plainRun.saves.at(-1)).toMatchObject({
      resultBranch: "feature/login",
      resultBaseBranch: null,
    });
  });

  it("never gives a start in an existing Instance a branch", () => {
    const start = newOrbitThreadStart({
      id: "s9",
      project,
      message: "m",
      suffix: "x",
      threadId: "t",
      messageId: "m",
      commandId: "c",
      now: 0,
      existing: { instanceId: 41, environmentId: "env-41", name: "dark-mode", nodeName: "shark" },
      branch: { mode: "new", from: "main" },
    });
    expect(start.branch).toBeNull();
  });
});

describe("retryOrbitThreadStartRecord", () => {
  const failedConnect = {
    ...fresh(),
    environmentId: "env-41",
    instanceId: 41,
    createStartedAt: 1,
    createFinishedAt: 9,
    connectStartedAt: 10,
    error: "Orbit could not pair.",
    errorCode: "conn.server_unreachable",
    errorDetail: "connection refused",
  };

  it("clears the error and the times of the stages that run again", () => {
    expect(retryOrbitThreadStartRecord(failedConnect)).toMatchObject({
      error: null,
      errorCode: null,
      errorDetail: null,
      createStartedAt: 1,
      createFinishedAt: 9,
      connectStartedAt: null,
      agentStartedAt: null,
    });
  });

  it("keeps a running create's time when its Operation is still followed", () => {
    const busy = { ...fresh(), createStartedAt: 3, createOperationId: 100, error: "timeout" };
    expect(retryOrbitThreadStartRecord(busy).createStartedAt).toBe(3);
    const refused = { ...busy, createOperationId: null };
    expect(retryOrbitThreadStartRecord(refused).createStartedAt).toBeNull();
  });
});

describe("orbitThreadStartCreatedInstance", () => {
  it("is true once the create was admitted or finished, never for an existing Instance", () => {
    expect(orbitThreadStartCreatedInstance(fresh())).toBe(false);
    expect(orbitThreadStartCreatedInstance({ ...fresh(), instanceId: 41 })).toBe(true);
    expect(orbitThreadStartCreatedInstance({ ...fresh(), environmentId: "env-41" })).toBe(true);
    expect(
      orbitThreadStartCreatedInstance({
        ...fresh(),
        orbitInstanceKind: "existing",
        instanceId: 41,
        environmentId: "env-41",
      }),
    ).toBe(false);
  });
});

describe("runOrbitThreadStart with a completion (release 2030)", () => {
  it("opens the thread at create success and saves the completion, not an error", async () => {
    const { client } = gateway({ createExtra: { completionOperationId: 106, routeId: 77 } });
    const run = ports(client);
    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(true);
    const last = run.saves.at(-1)!;
    expect(run.sent).toHaveLength(1);
    expect(last).toMatchObject({
      connected: true,
      error: null,
      completionOperationId: 106,
      completionStatus: "queued",
    });
    expect(last.sentAt).not.toBeNull();
    expect(last.createRows?.address?.status).toBe("running");
    expect(last.createRows?.t3?.status).toBe("done");
  });

  it("an older Gateway's create names no completion: all rows done, nothing to follow", async () => {
    const { client } = gateway({});
    const run = ports(client);
    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(true);
    const last = run.saves.at(-1)!;
    expect(last.completionOperationId).toBeNull();
    expect(last.completionStatus).toBeUndefined();
  });
});
