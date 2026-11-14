import { describe, expect, it } from "vite-plus/test";

import type { OrbitGatewayOperation } from "./client.ts";
import { orbitSetupStages } from "./orbitSetupStages.ts";
import { newOrbitThreadStart, type OrbitThreadStart } from "./threadStart.ts";

const project = { id: 3, slug: "mealou", name: "Mealou", nodeId: 7, nodeName: "beast" };
const base = newOrbitThreadStart({
  id: "s1",
  project,
  message: "Fix the login bug",
  suffix: "k3j9",
  threadId: "thread-1",
  messageId: "message-1",
  commandId: "command-1",
  now: 0,
  instanceName: "fix-login",
});
const creating = { ...base, createStartedAt: 10, createOperationId: 100, instanceId: 41 };
const created = { ...creating, environmentId: "env-41", createFinishedAt: 40 };
const pairing = { ...created, connectStartedAt: 41, pairingOperationId: 200 };
const connected = { ...pairing, connected: true, connectFinishedAt: 50, agentStartedAt: 51 };

function createOp(
  status: OrbitGatewayOperation["status"],
  progress: Partial<OrbitGatewayOperation> = {},
): OrbitGatewayOperation {
  return {
    id: 100,
    kind: "instance.create",
    status,
    targetId: 41,
    errorCode: null,
    pollAfterSeconds: 2,
    ...progress,
  };
}

/** Each stage as `id:status`, with a failed stage's code. */
function summary(start: OrbitThreadStart, create: OrbitGatewayOperation | null = null): string[] {
  return orbitSetupStages({ start, create }).map((stage) =>
    [`${stage.id}:${stage.status}`, stage.errorCode].filter(Boolean).join(" "),
  );
}

describe("orbitSetupStages", () => {
  it.each<[string, OrbitThreadStart, OrbitGatewayOperation | null, string[]]>([
    ["saved, not run yet", base, null, ["create:pending", "connect:pending", "agent:pending"]],
    [
      "create queued",
      creating,
      createOp("queued"),
      ["create:running", "connect:pending", "agent:pending"],
    ],
    [
      "Conn's empty steps[] with failed_step",
      { ...creating, error: "Orbit could not create the clone.", errorCode: "instance.t3_unready" },
      createOp("failed", { steps: [], currentStep: null, failedStep: "clone-register" }),
      ["create:failed instance.t3_unready", "connect:pending", "agent:pending"],
    ],
    [
      "Conn's empty steps[] on a succeeded create, before the clone's server is found",
      creating,
      createOp("succeeded", { steps: [], currentStep: null }),
      ["create:done", "connect:pending", "agent:pending"],
    ],
    [
      "failed step",
      {
        ...base,
        createStartedAt: 10,
        error: "Orbit could not create the clone.",
        errorCode: "instance.t3_unready",
      },
      createOp("failed", { failedStep: "clone-t3", errorCode: "instance.t3_unready" }),
      ["create:failed instance.t3_unready", "connect:pending", "agent:pending"],
    ],
    [
      "name taken",
      {
        ...base,
        createStartedAt: 10,
        error: "The name is taken.",
        errorCode: "instance.name_taken",
      },
      null,
      ["create:failed instance.name_taken", "connect:pending", "agent:pending"],
    ],
    [
      "a Retry while the last read still shows the failed create",
      creating,
      createOp("failed", { failedStep: "clone-t3" }),
      ["create:running", "connect:pending", "agent:pending"],
    ],
    [
      "pairing",
      pairing,
      createOp("succeeded"),
      ["create:done", "connect:running", "agent:pending"],
    ],
    [
      "pairing failed",
      { ...pairing, error: "Orbit could not pair.", errorCode: "conn.server_unreachable" },
      null,
      // The header shows the card's failure (failures.html 5).
      ["create:failed", "connect:failed conn.server_unreachable", "agent:pending"],
    ],
    ["connected", connected, null, ["create:done", "connect:done", "agent:running"]],
    [
      "the launch failed",
      { ...connected, error: "The clone did not take the first message." },
      null,
      ["create:failed", "connect:done", "agent:failed"],
    ],
    ["sent", { ...connected, sentAt: 60 }, null, ["create:done", "connect:done", "agent:done"]],
    [
      "an old row mid-create, without stage times",
      { ...base, createOperationId: 100, instanceId: 41 },
      null,
      ["create:running", "connect:pending", "agent:pending"],
    ],
  ])("maps %s", (_name, start, create, expected) => {
    expect(summary(start, create)).toEqual(expected);
  });

  it("gives the create stage its Node and every stage its times", () => {
    expect(orbitSetupStages({ start: { ...connected, sentAt: 60 } })).toEqual([
      {
        id: "create",
        status: "done",
        startedAt: 10,
        finishedAt: 40,
        detail: "beast",
        rows: null,
        error: null,
        errorCode: null,
      },
      {
        id: "connect",
        status: "done",
        startedAt: 41,
        finishedAt: 50,
        detail: null,
        rows: null,
        error: null,
        errorCode: null,
      },
      {
        id: "agent",
        status: "done",
        startedAt: 51,
        finishedAt: 60,
        detail: null,
        rows: null,
        error: null,
        errorCode: null,
      },
    ]);
  });

  const rows = (start: OrbitThreadStart) =>
    orbitSetupStages({ start })[0]!.rows?.map((row) => `${row.label}:${row.status}`) ?? null;
  const header = (start: OrbitThreadStart) => orbitSetupStages({ start })[0]!.status;
  const saved = {
    ...creating,
    createRows: {
      container: { status: "done", startedAt: 11, finishedAt: 20 },
      address: { status: "running", startedAt: 12, finishedAt: null },
      t3: { status: "running", startedAt: 20, finishedAt: null },
    },
  } satisfies OrbitThreadStart;
  const atCreateSuccess = {
    environmentId: "env-41",
    createFinishedAt: 40,
    completionOperationId: 106,
    completionStatus: "running",
    createRows: {
      container: { status: "done", startedAt: 11, finishedAt: 20 },
      address: { status: "running", startedAt: 12, finishedAt: null },
      t3: { status: "done", startedAt: 20, finishedAt: 30 },
      register: { status: "done", startedAt: 30, finishedAt: 40 },
    },
  } as const;

  it("shows all four rows before anything ran (storyboard 1 before the first read)", () => {
    expect(rows(creating)).toEqual([
      "Copy the container:pending",
      "Publish the address:pending",
      "Start the T3 server:pending",
      "Register with Orbit:pending",
    ]);
    expect(rows(base)).toHaveLength(4);
    expect(header(creating)).toBe("running");
  });

  it("shows the saved rows while the create runs (storyboard 2)", () => {
    expect(rows(saved)).toEqual([
      "Copy the container:done",
      "Publish the address:running",
      "Start the T3 server:running",
      "Register with Orbit:pending",
    ]);
  });

  it("refused at the start: all four rows pending, header failed (failures 1)", () => {
    const refused = { ...base, error: "The branch is in use.", errorCode: "branch.in_use" };
    expect(rows(refused)).toEqual([
      "Copy the container:pending",
      "Publish the address:pending",
      "Start the T3 server:pending",
      "Register with Orbit:pending",
    ]);
    expect(header(refused)).toBe("failed");
  });

  it("an unnamed failure stops the row that ran; the address did not start (failures 3)", () => {
    const stopped = { ...saved, error: "Orbit did not finish.", errorCode: "operation.timeout" };
    expect(rows(stopped)).toEqual([
      "Copy the container:done",
      "Publish the address:pending",
      "Start the T3 server:failed",
      "Register with Orbit:pending",
    ]);
    expect(header(stopped)).toBe("failed");
  });

  it("after the create, the header and the address spin while the completion runs (storyboard 4-6)", () => {
    const registered = { ...creating, ...atCreateSuccess };
    expect(header(registered)).toBe("running");
    expect(rows(registered)).toEqual([
      "Copy the container:done",
      "Publish the address:running",
      "Start the T3 server:done",
      "Register with Orbit:done",
    ]);
    const working = { ...registered, connected: true, connectFinishedAt: 50, sentAt: 60 };
    expect(summary(working)).toEqual(["create:running", "connect:done", "agent:done"]);
  });

  it("Connect fails while the completion runs: the address still spins, the header fails (failures 5)", () => {
    const failed = {
      ...creating,
      ...atCreateSuccess,
      connectStartedAt: 41,
      error: "Could not pair with the clone.",
    };
    expect(header(failed)).toBe("failed");
    expect(rows(failed)?.[1]).toBe("Publish the address:running");
  });

  it("the completion failed: address failed, header failed (failures 6)", () => {
    const failed = {
      ...creating,
      ...atCreateSuccess,
      connected: true,
      sentAt: 60,
      completionStatus: "failed",
      createRows: {
        ...atCreateSuccess.createRows,
        address: { status: "failed", startedAt: 12, finishedAt: 70 },
      },
    } satisfies OrbitThreadStart;
    expect(header(failed)).toBe("failed");
    expect(rows(failed)).toEqual([
      "Copy the container:done",
      "Publish the address:failed",
      "Start the T3 server:done",
      "Register with Orbit:done",
    ]);
  });

  it("an older build's saved rows: the address row follows the completion's phase", () => {
    // Builds before this change saved a failed completion on the workspace row.
    const older = {
      ...creating,
      ...atCreateSuccess,
      connected: true,
      sentAt: 60,
      completionStatus: "failed",
      createRows: {
        ...atCreateSuccess.createRows,
        address: { status: "done", startedAt: 12, finishedAt: 30 },
      },
    } satisfies OrbitThreadStart;
    expect(rows(older)?.[1]).toBe("Publish the address:failed");
    expect(rows({ ...older, completionStatus: "running" })?.[1]).toBe(
      "Publish the address:running",
    );
    // A Retry Orbit has not answered yet.
    const retry: OrbitThreadStart = {
      ...older,
      completionStatus: "queued",
      completionOperationId: null,
      completionKey: "k",
    };
    expect(rows(retry)?.[1]).toBe("Publish the address:running");
  });

  it("keeps the header spinning between the create's success and the saved completion", () => {
    const succeeded = createOp("succeeded", { completionOperationId: 106 });
    const start = {
      ...creating,
      createRows: {
        container: { status: "done", startedAt: 11, finishedAt: 20 },
        address: { status: "running", startedAt: 12, finishedAt: null },
        t3: { status: "done", startedAt: 20, finishedAt: 30 },
        register: { status: "done", startedAt: 30, finishedAt: 40 },
      },
    } satisfies OrbitThreadStart;
    const [stage] = orbitSetupStages({ start, create: succeeded });
    expect(stage!.status).toBe("running");
    expect(stage!.rows?.map((row) => row.status)).toEqual(["done", "running", "done", "done"]);
    // An older Gateway (no completion): done and folded.
    expect(orbitSetupStages({ start, create: createOp("succeeded") })[0]!.rows).toBe(null);
  });

  it("a create Orbit finished but Conn failed after it: the completion runs, the address spins", () => {
    // Orbit lists no T3 server for the clone: Conn fails the start, Orbit's completion runs on.
    const failed = {
      ...creating,
      error: "Orbit created the clone but lists no T3 server for it.",
      createRows: atCreateSuccess.createRows,
    } satisfies OrbitThreadStart;
    expect(header(failed)).toBe("failed");
    expect(rows(failed)).toEqual([
      "Copy the container:done",
      "Publish the address:running",
      "Start the T3 server:done",
      "Register with Orbit:done",
    ]);
  });

  it("folds the rows once the address is live, or when there is no completion (storyboard 7)", () => {
    const live: OrbitThreadStart = {
      ...creating,
      ...atCreateSuccess,
      sentAt: 60,
      completionStatus: "succeeded",
    };
    expect(header(live)).toBe("done");
    expect(rows(live)).toBe(null);
    expect(rows({ ...saved, environmentId: "env-41", createFinishedAt: 40 })).toBe(null);
  });

  it("shows only Connect and Start agent for an existing Instance", () => {
    const existing = newOrbitThreadStart({
      id: "s2",
      project,
      message: "Add a dark mode",
      suffix: "unused",
      threadId: "thread-2",
      messageId: "message-2",
      commandId: "command-2",
      now: 0,
      existing: { instanceId: 41, environmentId: "env-41", name: "dark-mode", nodeName: "beast" },
    });
    expect(summary(existing)).toEqual(["connect:pending", "agent:pending"]);
    expect(summary({ ...existing, connectStartedAt: 5 })).toEqual([
      "connect:running",
      "agent:pending",
    ]);
    expect(summary({ ...existing, connected: true })).toEqual(["connect:done", "agent:running"]);
    expect(
      summary({ ...existing, error: "Pairing expired.", errorCode: "operation.timeout" }),
    ).toEqual(["connect:failed operation.timeout", "agent:pending"]);
  });

  it("keeps Connect pending after the create until the runner stamps it", () => {
    expect(summary(created)).toEqual(["create:done", "connect:pending", "agent:pending"]);
    expect(summary({ ...created, connectStartedAt: 41 })).toEqual([
      "create:done",
      "connect:running",
      "agent:pending",
    ]);
  });
});
