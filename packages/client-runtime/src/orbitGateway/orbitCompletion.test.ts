import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { OrbitGatewayError, type OrbitGatewayOperation } from "./client.ts";
import {
  admitOrbitCompletion,
  applyOrbitCompletionRead,
  orbitCompletionNeedsAdmission,
  followOrbitCompletion,
  orbitCompletionNeedsFollow,
  orbitCompletionPhase,
  retryOrbitCompletion,
  type OrbitCompletionPorts,
} from "./orbitCompletion.ts";
import { newOrbitThreadStart, type OrbitThreadStart } from "./threadStart.ts";

/** A sent start whose create succeeded with completion 106; the rows as at create success. */
function sentStart(extra: Partial<OrbitThreadStart> = {}): OrbitThreadStart {
  return {
    ...newOrbitThreadStart({
      id: "s1",
      project: { id: 3, slug: "mealou", nodeName: "beast" },
      message: "Fix the login bug",
      suffix: "k3j9",
      threadId: "thread-1",
      messageId: "message-1",
      commandId: "command-1",
      now: 0,
      pendingThread: true,
    }),
    createOperationId: 100,
    instanceId: 41,
    environmentId: "env-41",
    connected: true,
    sentAt: 30,
    completionOperationId: 106,
    completionStatus: "queued",
    createRows: {
      container: { status: "done", startedAt: 1, finishedAt: 7 },
      address: { status: "running", startedAt: 22, finishedAt: null },
      t3: { status: "done", startedAt: 10, finishedAt: 15 },
      register: { status: "done", startedAt: 15, finishedAt: 21 },
    },
    ...extra,
  };
}

function completion(
  id: number,
  status: OrbitGatewayOperation["status"],
  extra: Partial<OrbitGatewayOperation> = {},
): OrbitGatewayOperation {
  return {
    id,
    kind: "instance.complete",
    status,
    targetId: 41,
    errorCode: null,
    pollAfterSeconds: status === "running" || status === "queued" ? 2 : null,
    steps: [],
    ...extra,
  };
}

const failedWorkspace = (id = 106) =>
  completion(id, "failed", {
    errorCode: "instance.create_workspace_failed",
    error: { code: "instance.create_workspace_failed", message: null, detail: "composer exit 1" },
    failedStep: "clone-services",
    resultFailedStep: "workspace",
    recoveryRetryable: true,
    recoveryRequires: null,
  });

const isGatewayError = Schema.is(OrbitGatewayError);

/** The saved start in memory; reads answer from scripted lists per Operation id. */
function harness(
  start: OrbitThreadStart | null,
  reads: Record<number, Array<OrbitGatewayOperation | OrbitGatewayError>>,
  admit: Array<OrbitGatewayOperation | OrbitGatewayError> = [],
) {
  let saved = start;
  let clock = 1_000;
  const calls: string[] = [];
  const saves: OrbitThreadStart[] = [];
  const ports: OrbitCompletionPorts = {
    client: {
      operation: async (id) => {
        calls.push(`operation ${id}`);
        const queue = reads[id];
        if (!queue)
          throw new OrbitGatewayError({ code: "http.404", message: "", status: 404, details: {} });
        const next = queue.length > 1 ? queue.shift()! : queue[0]!;
        if (isGatewayError(next)) throw next;
        return next;
      },
      completeInstance: async (instanceId, key) => {
        calls.push(`complete ${instanceId} ${key}`);
        const next = admit.length > 1 ? admit.shift()! : admit[0]!;
        if (isGatewayError(next)) throw next;
        return next;
      },
    },
    read: () => saved,
    save: (next) => {
      saved = next;
      saves.push(next);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { ports, calls, saves, saved: () => saved, dismiss: () => (saved = null) };
}

const lost = (status = 0) =>
  new OrbitGatewayError({ code: "gateway.request_failed", message: "lost", status, details: {} });

describe("orbitCompletionPhase", () => {
  it.each([
    [{ completionOperationId: null }, "none"],
    [{ completionStatus: "running" as const }, "running"],
    [{ completionStatus: "succeeded" as const }, "succeeded"],
    [{ completionStatus: "failed" as const }, "failed"],
    [{ completionStatus: "interrupted" as const }, "failed"],
    // Q4: a cancel outside a removal (Orbit offers Retry) shows the failed card.
    [{ completionStatus: "cancelled" as const, completionRetryable: true }, "failed"],
    // A removal's cancel: no recovery.
    [{ completionStatus: "cancelled" as const, completionRetryable: false }, "removed"],
  ])("%o → %s", (extra, phase) => {
    expect(orbitCompletionPhase(sentStart(extra))).toBe(phase);
  });

  it("follows only sent pending starts with an open completion, and not a plus start (Q5)", () => {
    expect(orbitCompletionNeedsFollow(sentStart())).toBe(true);
    expect(orbitCompletionNeedsFollow(sentStart({ completionStatus: "failed" }))).toBe(false);
    expect(orbitCompletionNeedsFollow(sentStart({ completionOperationId: null }))).toBe(false);
    expect(orbitCompletionNeedsFollow(sentStart({ sentAt: null }))).toBe(false);
    expect(orbitCompletionNeedsFollow(sentStart({ message: "" }))).toBe(false);
  });
});

describe("followOrbitCompletion", () => {
  it("follows to success: the address row done, error and connected untouched", async () => {
    const h = harness(sentStart(), {
      106: [completion(106, "running"), completion(106, "succeeded")],
    });
    expect(await followOrbitCompletion(h.ports)).toBe("ended");
    expect(h.saved()).toMatchObject({
      completionStatus: "succeeded",
      error: null,
      connected: true,
    });
    expect(h.saved()!.createRows?.address?.status).toBe("done");
    expect(h.saved()!.createRows?.t3?.status).toBe("done");
  });

  it.each([
    ["workspace", "address"],
    ["route", "address"],
    ["database", "address"],
    ["check", "address"],
    ["something-new", "address"],
  ] as const)(
    "a failure in phase %s fails row %s, keeps connected and leaves error null",
    async (phase, row) => {
      const h = harness(sentStart(), {
        106: [{ ...failedWorkspace(), resultFailedStep: phase }],
      });
      expect(await followOrbitCompletion(h.ports)).toBe("ended");
      const saved = h.saved()!;
      expect(saved).toMatchObject({
        connected: true,
        error: null,
        errorCode: null,
        completionStatus: "failed",
        completionErrorCode: "instance.create_workspace_failed",
        completionErrorDetail: "composer exit 1",
        completionRetryable: true,
      });
      expect(saved.createRows?.[row]?.status).toBe("failed");
      expect(orbitCompletionPhase(saved)).toBe("failed");
    },
  );

  it("a refused admission (already failed at create success) fails the card after one read", async () => {
    const refused = completion(106, "failed", {
      errorCode: "instance.complete_unavailable",
      failedStep: "complete",
      resultFailedStep: "complete",
      recoveryRetryable: true,
    });
    const h = harness(sentStart(), { 106: [refused] });
    expect(await followOrbitCompletion(h.ports)).toBe("ended");
    expect(h.calls).toEqual(["operation 106"]);
    expect(h.saved()!.createRows?.address?.status).toBe("failed");
    expect(h.saved()!.completionErrorCode).toBe("instance.complete_unavailable");
  });

  it("a removal's cancel (no recovery) changes no row and shows nothing new", async () => {
    const before = sentStart();
    const h = harness(before, {
      106: [
        completion(106, "cancelled", { cancelRequested: true, errorCode: "operation.cancelled" }),
      ],
    });
    expect(await followOrbitCompletion(h.ports)).toBe("ended");
    expect(h.saved()!.createRows).toEqual(before.createRows);
    expect(orbitCompletionPhase(h.saved()!)).toBe("removed");
  });

  it("stops quietly with the rows as saved when the read is refused (404, Gateway gap G1)", async () => {
    const before = sentStart();
    const h = harness(before, {});
    expect(await followOrbitCompletion(h.ports)).toBe("lost");
    expect(h.saves).toEqual([]);
    expect(orbitCompletionPhase(h.saved()!)).toBe("running");
  });

  it("rides out a short outage, and stops quietly after 60 s of one", async () => {
    const short = harness(sentStart(), {
      106: [lost(), lost(503), completion(106, "succeeded")],
    });
    expect(await followOrbitCompletion(short.ports)).toBe("ended");
    expect(short.saved()!.completionStatus).toBe("succeeded");
    const long = harness(sentStart(), { 106: [lost()] });
    expect(await followOrbitCompletion(long.ports)).toBe("lost");
    expect(long.saves).toEqual([]);
  });

  it("resumes after a restart from the saved Operation id, and stops when the start goes", async () => {
    const h = harness(sentStart({ completionStatus: "running" }), {
      106: [completion(106, "running")],
    });
    let reads = 0;
    const client = h.ports.client;
    const ports: OrbitCompletionPorts = {
      ...h.ports,
      client: {
        ...client,
        operation: async (id) => {
          if (++reads === 2) h.dismiss();
          return client.operation(id);
        },
      },
    };
    expect(await followOrbitCompletion(ports)).toBe("stopped");
    expect(h.calls[0]).toBe("operation 106");
  });
});

describe("retryOrbitCompletion", () => {
  const failedStart = () =>
    applyOrbitCompletionRead(
      sentStart(),
      {
        ...failedWorkspace(),
        resultFailedStep: "route",
        steps: [
          {
            name: "clone-check",
            job: "complete",
            status: "succeeded",
            startedAt: null,
            finishedAt: null,
          },
        ],
      },
      2_000,
    );

  it("saves a new key first, calls /complete, and the failed row runs again", async () => {
    const h = harness(failedStart(), {}, [completion(107, "queued")]);
    await retryOrbitCompletion(h.ports);
    const first = h.saves[0]!;
    expect(first.completionKey).toBe("conn-thread-start:s1:complete:1000");
    expect(first.completionStatus).toBe("queued");
    expect(first.completionOperationId).toBeNull();
    expect(first.createRows?.address?.status).toBe("running");
    // While Orbit has not answered, the card runs and no follower reads the old Operation.
    expect(orbitCompletionPhase(first)).toBe("running");
    expect(orbitCompletionNeedsFollow(first)).toBe(false);
    expect(orbitCompletionNeedsAdmission(first)).toBe(true);
    expect(h.calls).toEqual(["complete 41 conn-thread-start:s1:complete:1000"]);
    expect(h.saved()).toMatchObject({
      completionOperationId: 107,
      completionStatus: "queued",
      completionErrorCode: null,
      connected: true,
      error: null,
    });
    expect(orbitCompletionNeedsFollow(h.saved()!)).toBe(true);
  });

  it("repeats a lost answer under the same key, then follows the new Operation", async () => {
    const h = harness(failedStart(), { 107: [completion(107, "succeeded")] }, [
      lost(),
      lost(502),
      completion(107, "running"),
    ]);
    await retryOrbitCompletion(h.ports);
    const keys = h.calls.map((call) => call.split(" ")[2]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(await followOrbitCompletion(h.ports)).toBe("ended");
    expect(orbitCompletionPhase(h.saved()!)).toBe("succeeded");
  });

  it("a second Retry uses a new key", async () => {
    const h = harness(failedStart(), {}, [completion(107, "queued")]);
    await retryOrbitCompletion(h.ports);
    h.ports.save(applyOrbitCompletionRead(h.saved()!, { ...failedWorkspace(107) }, 3_000));
    await h.ports.sleep(5);
    await retryOrbitCompletion(h.ports);
    expect(h.calls).toEqual([
      "complete 41 conn-thread-start:s1:complete:1000",
      "complete 41 conn-thread-start:s1:complete:1005",
    ]);
  });

  it("a 409 refusal shows the failed card with that code and the rows as before", async () => {
    const busy = new OrbitGatewayError({
      code: "operation.target_busy",
      message: "Another Operation owns this Instance.",
      status: 409,
      details: {},
    });
    const before = failedStart();
    const h = harness(before, {}, [busy]);
    await retryOrbitCompletion(h.ports);
    expect(h.saved()).toMatchObject({
      completionStatus: "failed",
      completionErrorCode: "operation.target_busy",
      completionRetryable: true,
      completionOperationId: null,
    });
    expect(orbitCompletionPhase(h.saved()!)).toBe("failed");
    const statuses = (start: OrbitThreadStart) =>
      Object.entries(start.createRows ?? {}).map(([id, row]) => `${id}:${row!.status}`);
    expect(statuses(h.saved()!)).toEqual(statuses(before));
    expect(statuses(before)).toContain("address:failed");
  });

  it("after a restart, sends an unanswered Retry again under its saved key", async () => {
    const cutOff = {
      ...failedStart(),
      completionOperationId: null,
      completionKey: "conn-thread-start:s1:complete:500",
      completionStatus: "queued" as const,
    };
    const h = harness(cutOff, {}, [completion(107, "running")]);
    await admitOrbitCompletion(h.ports);
    expect(h.calls).toEqual(["complete 41 conn-thread-start:s1:complete:500"]);
    expect(h.saved()!.completionOperationId).toBe(107);
    expect(orbitCompletionNeedsFollow(h.saved()!)).toBe(true);
  });

  it("does nothing for a completion that did not fail", async () => {
    const h = harness(sentStart(), {}, [completion(107, "queued")]);
    await retryOrbitCompletion(h.ports);
    expect(h.calls).toEqual([]);
  });
});
