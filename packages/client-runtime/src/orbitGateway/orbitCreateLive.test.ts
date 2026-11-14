import { describe, expect, it } from "vite-plus/test";

import type { OrbitGatewayOperation } from "./client.ts";
import { ORBIT_CREATE_LIVE_2061 } from "./fixtures/orbitCreateLive2061.ts";
import { applyOrbitCompletionRead } from "./orbitCompletion.ts";
import { ORBIT_CREATE_ROW_IDS, observeOrbitCreateRows } from "./orbitCreateRows.ts";
import { orbitSetupStages } from "./orbitSetupStages.ts";
import { newOrbitThreadStart, type OrbitThreadStart } from "./threadStart.ts";

/**
 * The card against the real step lists of Orbit release 2061: each create and completion is
 * replayed read by read (one read at every step start and end), as the runner reads it.
 */

interface LiveStep {
  readonly name: string;
  readonly job: string | null;
  readonly status: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}
interface LiveOperation {
  readonly id: number;
  readonly kind: string;
  readonly status: string;
  readonly route_publication: string | null;
  readonly completion_operation_id: number | null;
  readonly steps: readonly LiveStep[];
  readonly failed_step?: string | null;
}

const ms = (value: string | null) => (value === null ? null : Date.parse(value));

/** Every moment a step started or ended, in order. */
function moments(operation: LiveOperation): number[] {
  const all = operation.steps.flatMap((step) => [ms(step.started_at), ms(step.finished_at)]);
  return [...new Set(all.filter((t): t is number => t !== null))].toSorted((a, b) => a - b);
}

/** The Operation as a read at `at` sees it; at the last moment it has ended. */
function readAt(operation: LiveOperation, at: number, last: boolean): OrbitGatewayOperation {
  const steps = operation.steps.map((step) => {
    const start = ms(step.started_at);
    // Orbit sends no end time for some child steps: they end when they start.
    const end = ms(step.finished_at) ?? start;
    const status =
      step.status === "skipped" || last
        ? step.status
        : start === null || at < start
          ? "pending"
          : end === null || at < end
            ? "running"
            : step.status;
    return {
      name: step.name,
      job: step.job,
      status,
      startedAt: start !== null && at >= start ? step.started_at : null,
      finishedAt: end !== null && at >= end ? (step.finished_at ?? step.started_at) : null,
    };
  });
  return {
    id: operation.id,
    kind: operation.kind,
    status: last ? (operation.status as OrbitGatewayOperation["status"]) : "running",
    targetId: 41,
    errorCode: null,
    pollAfterSeconds: last ? null : 2,
    steps,
    ...(last && operation.failed_step ? { failedStep: operation.failed_step } : {}),
    ...(last && operation.completion_operation_id !== null
      ? { completionOperationId: operation.completion_operation_id }
      : {}),
    ...(last && operation.route_publication !== null
      ? { result: { route_publication: operation.route_publication } }
      : {}),
  };
}

const project = { id: 69, slug: "fixture", name: "Fixture", nodeId: 9, nodeName: "beast" };
const creating: OrbitThreadStart = {
  ...newOrbitThreadStart({
    id: "s1",
    project,
    message: "Reply with ok.",
    suffix: "k3j9",
    threadId: "thread-1",
    messageId: "message-1",
    commandId: "command-1",
    now: 0,
    instanceName: "tbp69",
  }),
  createStartedAt: 1,
  createOperationId: 100,
  instanceId: 41,
};

/** One card frame: each row (`-` = no state yet) and the "Create Instance" header. */
interface Frame {
  readonly rows: Record<string, string>;
  readonly header: string;
  readonly phase: "create" | "completion";
}

function frameOf(
  start: OrbitThreadStart,
  create: OrbitGatewayOperation,
  phase: Frame["phase"],
): Frame {
  const stage = orbitSetupStages({ start, create })[0]!;
  const rows: Record<string, string> = {};
  for (const id of ORBIT_CREATE_ROW_IDS) {
    // The card folds its rows away once the header is done: the rows then read done.
    rows[id] =
      stage.rows === null ? "done" : (stage.rows.find((row) => row.id === id)?.status ?? "-");
    if (rows[id] === "pending") rows[id] = "-";
  }
  return { rows, header: stage.status, phase };
}

/** Replays a create (and its completion, when it has one) and returns every card frame. */
function replay(create: LiveOperation, completion: LiveOperation | null = null): Frame[] {
  let start = creating;
  const frames: Frame[] = [];
  const times = moments(create);
  let lastRead: OrbitGatewayOperation | null = null;
  times.forEach((at, index) => {
    const read = readAt(create, at, index === times.length - 1);
    lastRead = read;
    start = { ...start, createRows: observeOrbitCreateRows(start.createRows ?? null, read, at) };
    frames.push(frameOf(start, read, "create"));
  });
  const ended = lastRead!;
  if (ended.status !== "succeeded") {
    // The runner saves the failure on the start.
    start = { ...start, error: "Orbit could not create the clone.", errorCode: "x" };
    frames.push(frameOf(start, ended, "create"));
    return frames;
  }
  // The runner saves the server and the completion, then opens the thread.
  start = {
    ...start,
    environmentId: "env-41",
    createFinishedAt: times.at(-1)!,
    ...(typeof ended.completionOperationId === "number"
      ? { completionOperationId: ended.completionOperationId, completionStatus: "queued" }
      : {}),
  };
  frames.push(frameOf(start, ended, "completion"));
  if (completion === null) return frames;
  const completionTimes = moments(completion);
  completionTimes.forEach((at, index) => {
    const read = readAt(completion, at, index === completionTimes.length - 1);
    start = applyOrbitCompletionRead(start, read, at);
    frames.push(frameOf(start, ended, "completion"));
  });
  return frames;
}

/** A row's states over the frames, with repeats folded. */
function history(frames: readonly Frame[], key: string): string[] {
  const values = frames.map((frame) => (key === "header" ? frame.header : frame.rows[key]!));
  return values.filter((value, index) => index === 0 || values[index - 1] !== value);
}

/** The approved running card: four rows that never go back, the address and header to the end. */
function expectApprovedRun(frames: readonly Frame[], completionSteps: number) {
  expect(history(frames, "container")).toEqual(["running", "done"]);
  expect(history(frames, "t3")).toEqual(["-", "running", "done"]);
  expect(history(frames, "register")).toEqual(["-", "running", "done"]);
  expect(history(frames, "address")).toEqual(["running", "done"]);
  expect(history(frames, "header")).toEqual(["running", "done"]);
  // The address and the header end together, on the completion's last read and no earlier.
  const doneAt = frames.findIndex((frame) => frame.rows.address === "done");
  expect(doneAt).toBe(frames.length - 1);
  expect(frames[doneAt]!.header).toBe("done");
  expect(frames.filter((frame) => frame.phase === "completion")).toHaveLength(completionSteps + 1);
  // Right after the create succeeded, the address still spins; the other rows are done.
  const handover = frames.find((frame) => frame.phase === "completion")!;
  expect(handover.rows).toEqual({
    container: "done",
    address: "running",
    t3: "done",
    register: "done",
  });
  expect(handover.header).toBe("running");
}

const live = ORBIT_CREATE_LIVE_2061 as unknown as Record<
  "published" | "deferred" | "noRoute",
  { create: LiveOperation; complete: LiveOperation }
> & { cancelled: { create: LiveOperation } };

describe("the card on Orbit release 2061's real step lists", () => {
  it("published in the create: clone-route ends, the create succeeds, the address spins until the completion ends", () => {
    const { create, complete } = live.published;
    expect(create.route_publication).toBe("published");
    expect(create.steps.map((step) => step.name)).toContain("clone-route-csr-0-0");
    // The completion skips its own `route` step.
    expect(complete.steps.find((step) => step.name === "route")?.status).toBe("skipped");
    const frames = replay(create, complete);
    expectApprovedRun(frames, moments(complete).length);
    // clone-route (and the TLS probe) ended long before the create did: the row still spins.
    const routeEnd = Date.parse(create.steps.find((s) => s.name === "clone-route")!.finished_at!);
    const createFrames = frames.filter((frame) => frame.phase === "create");
    const after = moments(create).findIndex((t) => t >= routeEnd);
    expect(createFrames.slice(after).every((frame) => frame.rows.address === "running")).toBe(true);
  });

  it("the first reads (clone-route-csr-0-0, csr) open only the copy and the address", () => {
    const frames = replay(live.published.create);
    expect(frames[0]!.rows).toEqual({
      container: "running",
      address: "running",
      t3: "-",
      register: "-",
    });
    expect(frames[2]!.rows).toEqual({
      container: "running",
      address: "running",
      t3: "-",
      register: "-",
    });
  });

  it("deferred: no publication in the create; the completion's route-csr and route are the address row", () => {
    const { create, complete } = live.deferred;
    expect(create.route_publication).toBe("deferred");
    expect(complete.steps.map((step) => step.name)).toContain("route-csr-0-0");
    expectApprovedRun(replay(create, complete), moments(complete).length);
  });

  it("no Route: no route_publication; the address row waits for the completion", () => {
    const { create, complete } = live.noRoute;
    expect(create.route_publication).toBeNull();
    expectApprovedRun(replay(create, complete), moments(complete).length);
  });

  it("an older Gateway without route_publication reads the same", () => {
    const create = { ...live.published.create, route_publication: null };
    expectApprovedRun(
      replay(create, live.published.complete),
      moments(live.published.complete).length,
    );
  });

  it("a publication step that fails during the create fails nothing; the completion publishes again", () => {
    const create: LiveOperation = {
      ...live.published.create,
      route_publication: "failed",
      steps: live.published.create.steps.map((step) =>
        step.name === "clone-route" || step.name.startsWith("Probe the site")
          ? { ...step, status: "failed" }
          : step,
      ),
    };
    expectApprovedRun(
      replay(create, live.deferred.complete),
      moments(live.deferred.complete).length,
    );
  });

  it("a cancelled create whose publication Orbit took back (route_publication failed): the copy and the address show X", () => {
    const frames = replay(live.cancelled.create);
    expect(live.cancelled.create.route_publication).toBe("failed");
    expect(history(frames, "container")).toEqual(["running", "failed"]);
    expect(history(frames, "address")).toEqual(["running", "failed"]);
    expect(history(frames, "t3")).toEqual(["-"]);
    expect(history(frames, "register")).toEqual(["-"]);
    expect(frames.at(-1)!.header).toBe("failed");
  });
});

/** The published create, failed at clone-t3 after clone-route published the address. */
function failedAfterPublished(routePublication: string | null): LiveOperation {
  const create = live.published.create;
  const t3End = create.steps.find((step) => step.name === "clone-t3")!.finished_at;
  const later = new Set(["clone-sessions", "clone-session-copy", "clone-register"]);
  // After the failure Orbit runs its closing steps.
  const closing = new Set(["finish", "clone-private-cleanup", "cleanup", "stop-container"]);
  return {
    ...create,
    status: "failed",
    failed_step: "clone-t3",
    route_publication: routePublication,
    completion_operation_id: null,
    steps: create.steps.map((step) =>
      step.name === "clone-t3"
        ? { ...step, status: "failed" }
        : later.has(step.name)
          ? { ...step, status: "skipped", started_at: null, finished_at: null }
          : step.name === "accepted"
            ? { ...step, status: "failed", started_at: t3End, finished_at: t3End }
            : closing.has(step.name)
              ? { ...step, status: "succeeded", started_at: t3End, finished_at: t3End }
              : step,
    ),
  };
}

describe("a create that fails after clone-route published the address", () => {
  it("published: the address row reads done (the address stays live until Retry or removal)", () => {
    const frames = replay(failedAfterPublished("published"));
    expect(frames.at(-1)!.rows).toEqual({
      container: "done",
      address: "done",
      t3: "failed",
      register: "-",
    });
    expect(frames.at(-1)!.header).toBe("failed");
    expect(history(frames, "address")).toEqual(["running", "done"]);
  });

  it("an older Gateway without route_publication: the address did not start (ring)", () => {
    expect(replay(failedAfterPublished(null)).at(-1)!.rows.address).toBe("-");
  });

  it("deferred: the address did not start (ring)", () => {
    expect(replay(failedAfterPublished("deferred")).at(-1)!.rows.address).toBe("-");
  });

  it("route_publication failed: the address row fails (X)", () => {
    expect(replay(failedAfterPublished("failed")).at(-1)!.rows.address).toBe("failed");
  });

  it("the address spins on every read before the create ended", () => {
    const frames = replay(failedAfterPublished("published"));
    expect(frames.slice(0, -2).every((frame) => frame.rows.address === "running")).toBe(true);
  });
});
