import { describe, expect, it } from "vite-plus/test";

import type { OrbitGatewayOperation, OrbitGatewayOperationStep } from "./client.ts";
import {
  ORBIT_CREATE_ROW_IDS,
  ORBIT_CREATE_ROW_LABELS,
  observeOrbitCompletionRows,
  observeOrbitCreateRows,
  orbitCreateRowOf,
  orbitFailedCreateAddressStatus,
  reopenOrbitCompletionRows,
  readSavedOrbitCreateRows,
  stopRunningOrbitCreateRows,
  type OrbitCreateRows,
} from "./orbitCreateRows.ts";

function step(
  name: string,
  status: string,
  extra: Partial<OrbitGatewayOperationStep> = {},
): OrbitGatewayOperationStep {
  return { name, job: null, status, startedAt: null, finishedAt: null, ...extra };
}

function op(
  status: OrbitGatewayOperation["status"],
  steps: readonly OrbitGatewayOperationStep[],
  extra: Partial<OrbitGatewayOperation> = {},
): OrbitGatewayOperation {
  return {
    id: 100,
    kind: "instance.create",
    status,
    targetId: 41,
    errorCode: null,
    pollAfterSeconds: 2,
    steps,
    ...extra,
  };
}

/** Each row that has a state, as `id:status`. */
function statuses(rows: OrbitCreateRows): string[] {
  return Object.entries(rows).map(([id, row]) => `${id}:${row!.status}`);
}

describe("the approved rows", () => {
  it("are the four rows in the approved order, without Copy the workspace", () => {
    expect(ORBIT_CREATE_ROW_IDS.map((id) => ORBIT_CREATE_ROW_LABELS[id])).toEqual([
      "Copy the container",
      "Publish the address",
      "Start the T3 server",
      "Register with Orbit",
    ]);
  });
});

describe("orbitCreateRowOf", () => {
  it.each([
    // Today's create (swamp workflow-operation-instance-create.yaml, create 20511).
    ["input", "container"],
    ["clone-input", "container"],
    ["clone-container", "container"],
    ["clone-club-key", "container"],
    ["clone-workspace", "t3"],
    ["clone-t3", "t3"],
    ["clone-sessions", "register"],
    ["clone-session-copy", "register"],
    ["clone-register", "register"],
    ["finish", "register"],
    ["clone-private-cleanup", "register"],
    ["cleanup", "register"],
    ["accepted", "register"],
    // Orbit task group 5063: the Route publication inside the create.
    ["clone-route-csr", "address"],
    ["clone-route-csr-0", "address"],
    ["clone-route-csr-0-1", "address"],
    ["clone-route", "address"],
    // Older Gateways.
    ["clone-agent", "t3"],
    ["csr", "address"],
    ["sign", "address"],
    ["site", "address"],
    ["records-2", "address"],
    ["catalog-1", "address"],
    ["restart-caddy", "address"],
    ["Install cert, publish the route", "address"],
    ["Publish private DNS for meetup", "address"],
    ["Probe the site over TLS", "address"],
    // Unknown.
    ["withdraw-route", null],
    ["stop-container", null],
    ["clone-something-new", null],
    ["constructor", null],
  ])("puts %s in %s", (name, row) => {
    expect(orbitCreateRowOf({ name })).toBe(row);
  });

  it("prefers Orbit's group; the old workspace group is the T3 row", () => {
    expect(orbitCreateRowOf({ name: "clone-container", group: "t3" })).toBe("t3");
    expect(orbitCreateRowOf({ name: "brand-new", group: "workspace" })).toBe("t3");
    expect(orbitCreateRowOf({ name: "clone-t3", group: "later" })).toBe("t3");
  });
});

describe("observeOrbitCreateRows while the create runs", () => {
  it("starts the address with the copy, though today's create has no address step", () => {
    const rows = observeOrbitCreateRows(
      null,
      op("running", [
        step("input", "succeeded"),
        step("clone-input", "succeeded"),
        step("clone-container", "running"),
        step("clone-workspace", "pending"),
        step("clone-t3", "pending"),
      ]),
      1_000,
    );
    expect(statuses(rows)).toEqual(["container:running", "address:running"]);
  });

  it("keeps the address running through every later row (storyboard 2 and 3)", () => {
    let rows = observeOrbitCreateRows(null, op("running", [step("clone-container", "running")]), 1);
    rows = observeOrbitCreateRows(
      rows,
      op("running", [
        step("clone-container", "succeeded"),
        step("clone-workspace", "running"),
        step("clone-t3", "running"),
      ]),
      2,
    );
    expect(statuses(rows)).toEqual(["container:done", "address:running", "t3:running"]);
    rows = observeOrbitCreateRows(
      rows,
      op("running", [
        step("clone-container", "succeeded"),
        step("clone-workspace", "succeeded"),
        step("clone-t3", "succeeded"),
        step("clone-sessions", "running"),
      ]),
      3,
    );
    expect(statuses(rows)).toEqual([
      "container:done",
      "address:running",
      "t3:done",
      "register:running",
    ]);
  });

  it("maps the checkout to the T3 row: the T3 row runs until both ended", () => {
    const rows = observeOrbitCreateRows(
      null,
      op("running", [
        step("clone-container", "succeeded"),
        step("clone-t3", "succeeded"),
        step("clone-workspace", "running"),
      ]),
      1,
    );
    expect(rows.t3?.status).toBe("running");
  });

  it("keeps the address running when 5063's address steps end before the create does", () => {
    const rows = observeOrbitCreateRows(
      null,
      op("running", [
        step("clone-container", "succeeded"),
        step("clone-route-csr-0", "succeeded"),
        step("clone-route", "succeeded"),
        step("clone-t3", "running"),
      ]),
      1,
    );
    expect(statuses(rows)).toEqual(["container:done", "address:running", "t3:running"]);
  });

  it("fails the address row when a 5063 address step fails", () => {
    const rows = observeOrbitCreateRows(
      null,
      op("running", [step("clone-container", "running"), step("clone-route", "failed")]),
      1,
    );
    expect(rows.address?.status).toBe("failed");
    expect(rows.container?.status).toBe("running");
  });

  it("counts skipped steps as nothing", () => {
    const rows = observeOrbitCreateRows(
      null,
      op("running", [step("clone-input", "skipped"), step("clone-club-key", "skipped")]),
      1_000,
    );
    expect(statuses(rows)).toEqual([]);
  });

  it("keeps an unknown running step with the row that ran: no new row, never the address", () => {
    const before = observeOrbitCreateRows(null, op("running", [step("clone-t3", "running")]), 1);
    const rows = observeOrbitCreateRows(
      before,
      op("running", [step("clone-t3", "succeeded"), step("clone-mystery", "running")]),
      2,
    );
    expect(statuses(rows)).toEqual(["address:running", "t3:running"]);
    expect(
      Object.keys(rows).every((id) => (ORBIT_CREATE_ROW_IDS as readonly string[]).includes(id)),
    ).toBe(true);
  });

  it("an unknown first step counts for the copy, and an unknown finished step changes nothing", () => {
    const rows = observeOrbitCreateRows(
      null,
      op("running", [step("clone-new-first", "running")]),
      1,
    );
    expect(statuses(rows)).toEqual(["container:running", "address:running"]);
    const later = observeOrbitCreateRows(
      rows,
      op("running", [step("clone-new-first", "succeeded"), step("clone-new-other", "succeeded")]),
      2,
    );
    expect(later).toEqual(rows);
  });

  it("follows current_step alone: earlier rows done, the address still running", () => {
    const rows = observeOrbitCreateRows(null, op("running", [], { currentStep: "clone-t3" }), 5);
    expect(statuses(rows)).toEqual(["container:done", "address:running", "t3:running"]);
    const unknown = observeOrbitCreateRows(
      rows,
      op("running", [], { currentStep: "brand-new" }),
      6,
    );
    expect(statuses(unknown)).toEqual(["container:done", "address:running", "t3:running"]);
  });

  it("an unknown current_step after a stopped row never runs a done row again", () => {
    // A Retry after an unnamed failure: the copy is done, the T3 row failed and runs again.
    const before: OrbitCreateRows = {
      container: { status: "done", startedAt: 1, finishedAt: 2 },
      t3: { status: "failed", startedAt: 2, finishedAt: 3 },
    };
    const rows = observeOrbitCreateRows(before, op("running", [], { currentStep: "brand-new" }), 4);
    expect(rows.container?.status).toBe("done");
    expect(rows.t3?.status).toBe("running");
  });

  it("an unknown step after a done row, with nothing running, reopens no row", () => {
    const before: OrbitCreateRows = {
      container: { status: "done", startedAt: 1, finishedAt: 2 },
      address: { status: "running", startedAt: 1, finishedAt: null },
      t3: { status: "done", startedAt: 2, finishedAt: 3 },
    };
    const byCurrent = observeOrbitCreateRows(
      before,
      op("running", [], { currentStep: "x-new" }),
      4,
    );
    expect(statuses(byCurrent)).toEqual(["container:done", "address:running", "t3:done"]);
    const bySteps = observeOrbitCreateRows(before, op("running", [step("x-new", "running")]), 4);
    expect(statuses(bySteps)).toEqual(["container:done", "address:running", "t3:done"]);
  });

  it("a resumed create's unknown first step goes to the row that failed, not the copy", () => {
    const before: OrbitCreateRows = {
      container: { status: "done", startedAt: 1, finishedAt: 2 },
      address: { status: "pending", startedAt: 1, finishedAt: null },
      t3: { status: "failed", startedAt: 2, finishedAt: 3 },
    };
    const rows = observeOrbitCreateRows(before, op("running", [step("x-new", "running")]), 4);
    expect(statuses(rows)).toEqual(["container:done", "address:running", "t3:running"]);
  });

  it("never moves a row back to pending while the create runs", () => {
    const before = observeOrbitCreateRows(null, op("running", [step("clone-t3", "running")]), 1);
    expect(observeOrbitCreateRows(before, op("running", []), 2)).toEqual(before);
  });
});

const T = (seconds: number) => `2026-11-14T01:11:${String(seconds).padStart(2, "0")}.000Z`;
const ms = (seconds: number) => Date.parse(T(seconds));

/** Create 20511 (release 2030) as Conn reads it at its success, trimmed to the row steps. */
function createAtSuccess(extra: Partial<OrbitGatewayOperation> = {}): OrbitGatewayOperation {
  return op(
    "succeeded",
    [
      step("input", "succeeded", { job: "input", startedAt: T(21), finishedAt: T(22) }),
      step("clone-input", "succeeded", { job: "clone", startedAt: T(22), finishedAt: T(24) }),
      step("clone-container", "succeeded", { job: "clone", startedAt: T(24), finishedAt: T(31) }),
      step("clone-t3", "succeeded", { job: "clone", startedAt: T(31), finishedAt: T(36) }),
      step("clone-workspace", "succeeded", { job: "clone", startedAt: T(31), finishedAt: T(32) }),
      step("clone-register", "succeeded", { job: "clone", startedAt: T(40), finishedAt: T(41) }),
      step("finish", "succeeded", { job: "create", startedAt: T(41), finishedAt: T(42) }),
    ],
    { completionOperationId: 20512, routeId: 77, ...extra },
  );
}

describe("create success", () => {
  it("with a completion: the address runs on, the other three are done (storyboard 4)", () => {
    const rows = observeOrbitCreateRows(null, createAtSuccess(), ms(43));
    expect(statuses(rows)).toEqual([
      "container:done",
      "address:running",
      "t3:done",
      "register:done",
    ]);
  });

  it("with a completion and no Route: the address still waits for the database, Processes and checks", () => {
    const rows = observeOrbitCreateRows(null, createAtSuccess({ routeId: null }), ms(43));
    expect(rows.address?.status).toBe("running");
  });

  it.each(["published", "deferred", "failed"])(
    "with 5063's route_publication %s: the address follows the completion",
    (routePublication) => {
      const rows = observeOrbitCreateRows(
        null,
        createAtSuccess({ result: { route_publication: routePublication } }),
        ms(43),
      );
      expect(rows.address?.status).toBe("running");
    },
  );

  it("on an older Gateway that names no completion: all four done", () => {
    const { completionOperationId: _id, routeId: _route, ...older } = createAtSuccess();
    const rows = observeOrbitCreateRows(null, older, ms(43));
    expect(statuses(rows)).toEqual(["container:done", "address:done", "t3:done", "register:done"]);
  });
});

describe("create failure", () => {
  it("fails the row of the named step; the address did not start (failures 2, 3, 4)", () => {
    const running = observeOrbitCreateRows(
      null,
      op("running", [step("clone-container", "running")]),
      1,
    );
    expect(running.address?.status).toBe("running");
    const copy = observeOrbitCreateRows(
      running,
      op("failed", [step("clone-container", "failed")], { errorCode: "instance.clone_failed" }),
      2,
    );
    expect(statuses(copy)).toEqual(["container:failed", "address:pending"]);
    const t3 = observeOrbitCreateRows(
      running,
      op("failed", [step("clone-container", "succeeded"), step("clone-t3", "failed")]),
      2,
    );
    expect(statuses(t3)).toEqual(["container:done", "address:pending", "t3:failed"]);
    const register = observeOrbitCreateRows(
      running,
      op("failed", [], { failedStep: "clone-sessions", errorCode: "instance.t3_unready" }),
      2,
    );
    expect(register.register?.status).toBe("failed");
    expect(register.address?.status).toBe("pending");
  });

  it("puts an unknown failed step on the row that ran, never on the address", () => {
    const before = observeOrbitCreateRows(null, op("running", [step("clone-t3", "running")]), 1);
    const rows = observeOrbitCreateRows(
      before,
      op("failed", [], { failedStep: "clone-mystery" }),
      2,
    );
    expect(rows.t3?.status).toBe("failed");
    expect(rows.address?.status).toBe("pending");
  });

  it("keeps a failed 5063 address step failed", () => {
    const rows = observeOrbitCreateRows(
      null,
      op("failed", [step("clone-container", "succeeded"), step("clone-route", "failed")]),
      2,
    );
    expect(rows.address?.status).toBe("failed");
  });

  it("stopRunningOrbitCreateRows: the row that ran fails, the address did not start", () => {
    const before = observeOrbitCreateRows(null, op("running", [step("clone-t3", "running")]), 1);
    const stopped = stopRunningOrbitCreateRows(before, 9)!;
    expect(statuses(stopped)).toEqual(["address:pending", "t3:failed"]);
    expect(stopped.t3?.finishedAt).toBe(9);
  });

  it("orbitFailedCreateAddressStatus: today every failed create leaves the address unstarted", () => {
    for (const routePublication of [null, "published", "deferred", "failed"]) {
      expect(
        orbitFailedCreateAddressStatus({
          createStatus: "failed",
          routePublication,
          completionStatus: null,
        }),
      ).toBe("pending");
    }
  });
});

describe("readSavedOrbitCreateRows", () => {
  it("reads saved rows, drops broken ones and the old workspace row", () => {
    expect(
      readSavedOrbitCreateRows({
        container: { status: "done", startedAt: 1, finishedAt: 2 },
        address: { status: "weird" },
        workspace: { status: "running", startedAt: 1, finishedAt: null },
        t3: { status: "running", startedAt: "x" },
      }),
    ).toEqual({
      container: { status: "done", startedAt: 1, finishedAt: 2 },
      t3: { status: "running", startedAt: null, finishedAt: null },
    });
    expect(readSavedOrbitCreateRows(undefined)).toBe(null);
  });
});

function completion(
  status: OrbitGatewayOperation["status"],
  steps: readonly OrbitGatewayOperationStep[],
  extra: Partial<OrbitGatewayOperation> = {},
): OrbitGatewayOperation {
  return op(status, steps, { id: 20512, kind: "instance.complete", ...extra });
}

/** Completion 20512 (release 2030): every job and step Conn has seen in it. */
const COMPLETION_STEPS: readonly (readonly [string, string])[] = [
  ["input", "input"],
  ["clone-input", "complete"],
  ["database-snapshot", "complete"],
  ["server-database", "complete"],
  ["server-valkey", "complete"],
  ["database-install", "complete"],
  ["server-database-check", "complete"],
  ["server-valkey-check", "complete"],
  ["clone-fleet", "complete"],
  ["database-cleanup", "complete"],
  ["server-database-fill", "complete"],
  ["clone-services", "complete"],
  ["clone-check", "complete"],
  ["route-csr-0", "publication"],
  ["route-csr-0-0", "publication"],
  ["route", "publication"],
  ["csr", "create"],
  ["sign", "create"],
  ["site", "create"],
  ["Install cert, publish site-9-0", "create"],
  ["Probe the site over TLS-0-0", "create"],
  ["withdraw_route-0", "withdraw"],
  ["finish", "result"],
  ["clone-private-cleanup", "result"],
  ["withdraw-route", "result"],
  ["cleanup", "result"],
  ["accepted", "result"],
  ["something-new", "other"],
];

describe("observeOrbitCompletionRows: all of instance.complete is the address row", () => {
  const atCreate = () => observeOrbitCreateRows(null, createAtSuccess(), ms(43));

  it.each(COMPLETION_STEPS)("a running %s (job %s) keeps only the address running", (name, job) => {
    const rows = observeOrbitCompletionRows(
      atCreate(),
      completion("running", [step(name, "running", { job })]),
      ms(50),
    );
    expect(statuses(rows)).toEqual([
      "container:done",
      "address:running",
      "t3:done",
      "register:done",
    ]);
  });

  it.each(COMPLETION_STEPS)(
    "a failed %s (job %s) keeps the address running while it runs",
    (name, job) => {
      const rows = observeOrbitCompletionRows(
        atCreate(),
        completion("running", [step(name, "failed", { job })]),
        ms(50),
      );
      expect(statuses(rows)).toEqual([
        "container:done",
        "address:running",
        "t3:done",
        "register:done",
      ]);
    },
  );

  it("stays running while a route step is done but database, Processes or checks still run (storyboard 6)", () => {
    const rows = observeOrbitCompletionRows(
      atCreate(),
      completion("running", [
        step("route-csr-0-0", "succeeded", { job: "publication" }),
        step("route", "succeeded", { job: "publication" }),
        step("clone-services", "running", { job: "complete" }),
      ]),
      ms(50),
    );
    expect(rows.address?.status).toBe("running");
  });

  it("is done only when the completion succeeded (storyboard 7)", () => {
    const rows = observeOrbitCompletionRows(
      atCreate(),
      completion("succeeded", [
        step("clone-check", "succeeded", { job: "complete", finishedAt: T(54) }),
        step("route", "succeeded", { job: "publication", finishedAt: T(57) }),
      ]),
      ms(59),
    );
    expect(statuses(rows)).toEqual(["container:done", "address:done", "t3:done", "register:done"]);
  });

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "a completion that ended %s fails the address row, no other row reopens (failure 6)",
    (status) => {
      const rows = observeOrbitCompletionRows(
        atCreate(),
        completion(status, [], { resultFailedStep: "fleet" }),
        ms(60),
      );
      expect(statuses(rows)).toEqual([
        "container:done",
        "address:failed",
        "t3:done",
        "register:done",
      ]);
    },
  );

  it("a Retry runs the address row again and leaves the others done", () => {
    const failed = observeOrbitCompletionRows(atCreate(), completion("failed", []), ms(57));
    const reopened = reopenOrbitCompletionRows(failed)!;
    expect(statuses(reopened)).toEqual([
      "container:done",
      "address:running",
      "t3:done",
      "register:done",
    ]);
    const running = observeOrbitCompletionRows(reopened, completion("queued", []), ms(60));
    expect(running.address?.status).toBe("running");
  });
});
