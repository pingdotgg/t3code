import { describe, expect, it } from "vite-plus/test";

import {
  createOrbitGatewayClient,
  type OrbitGatewayRequest,
  type OrbitGatewayResponse,
} from "./client.ts";
import { parseOrbitInstanceGit } from "./instanceGit.ts";
import {
  DESTROY_TIMEOUT_MS,
  followOrbitInstanceRemoval,
  orbitInstanceRemoveOutcomeOf,
  orbitInstanceRemoveProgress,
  orbitInstanceRemoveStepText,
  orbitInstanceRemoveText,
  removeOrbitInstance,
  type OrbitInstanceRemoveProgress,
  type OrbitInstanceRemoveTarget,
} from "./instanceRemoval.ts";

const op = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 77,
  kind: "instance.destroy",
  status,
  target_id: 41,
  poll_after_seconds: ["succeeded", "failed", "cancelled", "interrupted"].includes(status)
    ? null
    : 2,
  ...extra,
});
const ok = (data: unknown, status = 200): OrbitGatewayResponse => ({
  status,
  body: JSON.stringify({ data }),
});
const error = (status: number, code: string, details: unknown = {}): OrbitGatewayResponse => ({
  status,
  body: JSON.stringify({ error: { code, message: `Orbit says ${code}.`, details } }),
});

/** A Gateway whose answers come from a script, one per request, through the real client. */
function gateway(answers: Array<OrbitGatewayResponse | Error>) {
  const requests: OrbitGatewayRequest[] = [];
  let clock = 0;
  const client = createOrbitGatewayClient(async (request) => {
    requests.push(request);
    const answer = answers.shift();
    if (answer === undefined) throw new Error("no more answers");
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const ports = {
    client,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
  const progress: OrbitInstanceRemoveProgress[] = [];
  const remove = (
    acknowledgeUnsaved = false,
    git = parseOrbitInstanceGit(undefined),
    stopped?: () => boolean,
  ) =>
    removeOrbitInstance(ports, {
      instanceId: 41,
      acknowledgeUnsaved,
      idempotencyKey: "key-1",
      ...(git ? { git } : {}),
      onProgress: (next) => progress.push(next),
      ...(stopped ? { stopped } : {}),
    });
  const follow = (operationId = 77) =>
    followOrbitInstanceRemoval(ports, {
      operationId,
      onProgress: (next) => progress.push(next),
    });
  return { requests, remove, follow, progress, elapsed: () => clock };
}

describe("removeOrbitInstance", () => {
  it("sends the destroy with its key and tick, then follows the Operation to its end", async () => {
    const orbit = gateway([ok(op("queued"), 202), ok(op("running")), ok(op("succeeded"))]);
    expect(await orbit.remove(true)).toEqual({ kind: "removed" });
    expect(orbit.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /instances/41/destroy",
      "GET /operations/77",
      "GET /operations/77",
    ]);
    expect(orbit.requests[0]).toMatchObject({
      body: { acknowledge_unsaved: true },
      idempotencyKey: "key-1",
    });
  });

  it.each(["http.404", "instance.not_found", "anything.else"])(
    "treats any 404 (%s) as an Instance that is already removed",
    async (code) => {
      const orbit = gateway([error(404, code)]);
      expect(await orbit.remove()).toEqual({ kind: "removed" });
      expect(orbit.requests).toHaveLength(1);
    },
  );

  it("returns the first release's unknown state without the tick, so the dialog asks for it", async () => {
    const orbit = gateway([
      error(409, "instance.unsaved_work", { state: "unknown", uncommitted: null, unpushed: null }),
    ]);
    expect(await orbit.remove(false)).toEqual({
      kind: "unsaved_work",
      git: { state: "unknown", reason: null },
    });
    expect(orbit.requests).toHaveLength(1);
  });

  it("returns Orbit's unsaved work without the tick, so the dialog can ask for it", async () => {
    const orbit = gateway([
      error(409, "instance.unsaved_work", { uncommitted: 3, unpushed: null, state: "dirty" }),
    ]);
    const listed = parseOrbitInstanceGit({
      state: "known",
      branch: "pricing-page",
      uncommitted: 0,
      unpushed: 2,
    });
    expect(await orbit.remove(false, listed)).toEqual({
      kind: "unsaved_work",
      git: expect.objectContaining({ state: "known", uncommitted: 3, unpushed: 2 }),
    });
    expect(orbit.requests).toHaveLength(1);
  });

  it.each([
    [403, "node_access.required"],
    [422, "validation.failed"],
    [409, "instance.default_protected"],
    [409, "instance.not_container"],
    [409, "instance.lifecycle_busy"],
    [409, "instance.database_attached_elsewhere"],
    [409, "operation.target_busy"],
    [409, "operation.idempotency_conflict"],
  ])("reports a %i %s refusal as a failure with Orbit's words", async (status, code) => {
    const orbit = gateway([error(status, code)]);
    expect(await orbit.remove(true)).toEqual({
      kind: "failed",
      code,
      message: `Orbit says ${code}.`,
    });
    expect(orbit.requests).toHaveLength(1);
  });

  it("repeats a lost destroy request under the same key, and rides out a short outage", async () => {
    const orbit = gateway([
      new Error("socket hang up"),
      ok(op("running"), 202),
      new Error("socket hang up"),
      ok(op("succeeded")),
    ]);
    expect(await orbit.remove(true)).toEqual({ kind: "removed" });
    expect(orbit.requests.map((request) => request.idempotencyKey ?? null)).toEqual([
      "key-1",
      "key-1",
      null,
      null,
    ]);
  });

  it("shows a failed or cancelled destroy as failed, with the Operation's code", async () => {
    const failing = gateway([
      ok(op("running"), 202),
      ok(
        op("failed", {
          error: { code: "swamp.destroy_failed", message: "Swamp lost the Node.", detail: null },
        }),
      ),
    ]);
    expect(await failing.remove(true)).toEqual({
      kind: "failed",
      code: "swamp.destroy_failed",
      message: "Swamp lost the Node.",
    });

    const silent = gateway([ok(op("running"), 202), ok(op("cancelled"))]);
    expect(await silent.remove(true)).toEqual({
      kind: "failed",
      code: "operation.cancelled",
      message: "Orbit did not finish removing the Instance.",
    });
  });

  it("stops polling on an interrupted Operation", async () => {
    const orbit = gateway([
      ok(op("running"), 202),
      ok(op("interrupted", { error: { code: null, message: null, detail: null } })),
    ]);
    expect(await orbit.remove(true)).toEqual({
      kind: "failed",
      code: "operation.interrupted",
      message: "Orbit did not finish removing the Instance.",
    });
    expect(orbit.requests).toHaveLength(2);
  });

  it("refuses an Operation that is not a destroy", async () => {
    const orbit = gateway([ok(op("queued", { kind: "instance.create" }), 202)]);
    expect(await orbit.remove(true)).toMatchObject({
      kind: "failed",
      code: "gateway.response_invalid",
    });
  });
});

describe("removal states (conn remove UX, 2026-11-13)", () => {
  it("reports admission, a queue place and plain steps while Orbit works", async () => {
    const orbit = gateway([
      ok(op("queued"), 202),
      ok(op("running", { capacity_wait: { position: 2 } })),
      ok(op("running", { current_step: "Stop, remove Processes-1-1" })),
      ok(op("running", { current_step: "input" })),
      ok(op("succeeded")),
    ]);
    expect(await orbit.remove(true)).toEqual({ kind: "removed" });
    expect(orbit.progress).toEqual([
      { kind: "admitted", operationId: 77 },
      { kind: "waiting" },
      { kind: "waiting" },
      { kind: "running", step: "Stopping its processes" },
      { kind: "running", step: null },
    ]);
  });

  it("accepts a destroy that waits behind a running completion's cancel (release 2030)", async () => {
    const orbit = gateway([
      ok(op("waiting"), 202),
      ok(op("waiting")),
      ok(op("running", { current_step: "Stop, remove Processes-1-1" })),
      ok(op("succeeded")),
    ]);
    expect(await orbit.remove(true)).toEqual({ kind: "removed" });
    expect(orbit.progress).toEqual([
      { kind: "admitted", operationId: 77 },
      { kind: "waiting" },
      { kind: "waiting" },
      { kind: "running", step: "Stopping its processes" },
    ]);
  });

  it("uses Orbit's detail when a failed start has no message (Nick's four removals)", async () => {
    const orbit = gateway([
      ok(op("queued"), 202),
      ok(
        op("failed", {
          error_code: "swamp.start_unavailable",
          error: {
            code: "swamp.start_unavailable",
            detail: "The native workflow start could not connect.",
          },
        }),
      ),
    ]);
    expect(await orbit.remove(true)).toEqual({
      kind: "failed",
      code: "swamp.start_unavailable",
      message: "The native workflow start could not connect.",
    });
  });

  it.each(["failed", "cancelled", "interrupted"])(
    "maps a %s Operation to a failure, and succeeded to removed",
    (status) => {
      const parse = (value: unknown) =>
        createOrbitGatewayClient(async () => ok(value)).operation(77);
      return Promise.all([parse(op(status)), parse(op("succeeded")), parse(op("running"))]).then(
        ([ended, succeeded, running]) => {
          expect(orbitInstanceRemoveOutcomeOf(ended)).toEqual({
            kind: "failed",
            code: `operation.${status}`,
            message: "Orbit did not finish removing the Instance.",
          });
          expect(orbitInstanceRemoveOutcomeOf(succeeded)).toEqual({ kind: "removed" });
          expect(orbitInstanceRemoveOutcomeOf(running)).toBeNull();
          expect(orbitInstanceRemoveProgress(running)).toEqual({ kind: "running", step: null });
        },
      );
    },
  );

  it("never calls a long destroy failed: it keeps reading, slower, until Orbit ends it", async () => {
    const orbit = gateway([
      ok(op("running"), 202),
      ...Array.from({ length: 400 }, () => ok(op("running"))),
      ok(op("succeeded")),
    ]);
    expect(await orbit.remove(true)).toEqual({ kind: "removed" });
    expect(orbit.elapsed()).toBeGreaterThan(DESTROY_TIMEOUT_MS);
  });

  it("stops following when asked, without a verdict", async () => {
    let reads = 0;
    const orbit = gateway([ok(op("running"), 202), ok(op("running")), ok(op("running"))]);
    expect(await orbit.remove(true, undefined, () => ++reads > 1)).toEqual({ kind: "stopped" });
  });

  it("follows a saved Operation again, and calls a 404 on it lost", async () => {
    const saved = gateway([
      ok(op("running", { current_step: "Verify it is gone" })),
      ok(op("failed")),
    ]);
    expect(await saved.follow()).toMatchObject({ kind: "failed", code: "operation.failed" });
    expect(saved.progress).toEqual([{ kind: "running", step: "Checking it is gone" }]);
    expect(saved.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /operations/77",
      "GET /operations/77",
    ]);

    // A 404 on the Conn read falls back to Orbit's own read; lost only when both say 404.
    const gone = gateway([error(404, "http.404"), error(404, "http.404")]);
    expect(await gone.follow()).toEqual({ kind: "lost" });
    expect(gone.requests.map((request) => request.root === true)).toEqual([false, true]);
  });

  it("keeps following a saved Operation through a 401 or a 5xx, and its id is never dropped", async () => {
    const orbit = gateway([
      error(401, "auth.unauthenticated"),
      error(503, "http.503"),
      ok(op("running")),
      error(429, "http.429"),
      ok(op("succeeded")),
    ]);
    expect(await orbit.follow()).toEqual({ kind: "removed" });
  });

  it("names today's destroy steps in plain words, and no text for unknown steps", () => {
    expect(orbitInstanceRemoveStepText("Withdraw the Route")).toBe("Taking the address offline");
    expect(orbitInstanceRemoveStepText("withdraw_node-0-0")).toBe("Taking the address offline");
    expect(orbitInstanceRemoveStepText("Remove hibernation files-2-2")).toBe("Removing its files");
    expect(orbitInstanceRemoveStepText("Check work is pushed")).toBe("Checking for unpushed work");
    expect(orbitInstanceRemoveStepText("compose")).toBeNull();
    expect(orbitInstanceRemoveStepText(null)).toBeNull();
  });
});

describe("orbitInstanceRemoveText", () => {
  const target = (extra: Partial<OrbitInstanceRemoveTarget>): OrbitInstanceRemoveTarget => ({
    name: "pricing-page",
    domain: "pricing-page.nckrtl.test",
    nodeName: "beast",
    threadCount: 2,
    workingCount: 0,
    git: parseOrbitInstanceGit({
      state: "known",
      branch: "pricing-page",
      uncommitted: 0,
      unpushed: 0,
    }),
    ...extra,
  });
  const known = (uncommitted: number, unpushed: number) =>
    parseOrbitInstanceGit({ state: "known", branch: "pricing-page", uncommitted, unpushed });

  it("asks once for a clean Instance, with the thread count in words", () => {
    const text = orbitInstanceRemoveText(target({}));
    expect(`${text.before}${text.target}${text.after}`).toBe(
      "Orbit removes the Instance pricing-page.nckrtl.test on beast and its container. The 2 threads in it are removed from Conn. You cannot undo this.",
    );
    expect(text).toMatchObject({ title: "Remove pricing-page?", warning: null, acknowledge: null });
    expect(orbitInstanceRemoveText(target({ threadCount: 1 })).after).toContain(
      "The thread in it is removed from Conn.",
    );
    expect(orbitInstanceRemoveText(target({ threadCount: 0 })).after).toContain(
      "It has no threads.",
    );
  });

  it("lists the work that is lost and asks for the tick", () => {
    expect(orbitInstanceRemoveText(target({ git: known(3, 2) }))).toMatchObject({
      warning: {
        kind: "lost",
        heading: "This Instance holds work that is not on the remote:",
        items: ["3 uncommitted changes", "2 commits not pushed on branch pricing-page"],
      },
      acknowledge: "Remove it anyway. This work is lost.",
    });
    expect(orbitInstanceRemoveText(target({ workingCount: 1 }))).toMatchObject({
      warning: {
        heading: "This Instance is in use:",
        items: ["1 thread is working now. It stops."],
      },
      acknowledge: "Remove it anyway. The thread stops.",
    });
    expect(
      orbitInstanceRemoveText(target({ git: { state: "unknown", reason: "stopped" } })),
    ).toMatchObject({
      warning: {
        kind: "unknown",
        text: "Orbit cannot tell whether this Instance holds work that is not on the remote.",
      },
      acknowledge: "Remove it anyway. Any unsaved work is lost.",
    });
    // No Git state from the list: one confirmation, or the working thread alone; Orbit's refusal
    // brings the unknown state.
    expect(orbitInstanceRemoveText(target({ git: undefined }))).toMatchObject({
      warning: null,
      acknowledge: null,
    });
    expect(orbitInstanceRemoveText(target({ git: undefined, workingCount: 1 }))).toMatchObject({
      warning: { kind: "lost", heading: "This Instance is in use:" },
      acknowledge: "Remove it anyway. The thread stops.",
    });
  });
});
