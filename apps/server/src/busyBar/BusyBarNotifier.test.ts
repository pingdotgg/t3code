import { assert, describe, it } from "@effect/vitest";

import {
  type BusyBarThreadTracking,
  nextBusyBarAlert,
  resolveBusyBarEndpoint,
} from "./BusyBarNotifier.ts";

const replay = (phases: ReadonlyArray<Parameters<typeof nextBusyBarAlert>[1]>) => {
  let tracking: BusyBarThreadTracking | undefined;
  return phases.map((phase) => {
    const next = nextBusyBarAlert(tracking, phase);
    tracking = next.tracking;
    return next.alert;
  });
};

describe("nextBusyBarAlert", () => {
  it("announces a run that finishes or fails after working", () => {
    assert.deepEqual(replay(["running", "completed"]), [null, "completed"]);
    assert.deepEqual(replay(["starting", null, "failed"]), [null, null, "failed"]);
  });

  it("stays quiet for terminal states it never saw start", () => {
    assert.deepEqual(replay(["completed", "completed", null, "completed"]), [
      null,
      null,
      null,
      null,
    ]);
  });

  it("announces each new request for attention once, then the finish", () => {
    assert.deepEqual(
      replay([
        "running",
        "waiting_for_approval",
        "waiting_for_approval",
        "waiting_for_input",
        "running",
        "completed",
        "completed",
      ]),
      [null, "waiting_for_approval", null, "waiting_for_input", null, "completed", null],
    );
  });
});

describe("resolveBusyBarEndpoint", () => {
  it("talks to a local device under /api with its access password", () => {
    assert.deepEqual(resolveBusyBarEndpoint({ address: "10.0.4.20", token: "" }), {
      baseUrl: "http://10.0.4.20/api",
      headers: {},
    });
    assert.deepEqual(resolveBusyBarEndpoint({ address: "192.168.1.5", token: "pw" }), {
      baseUrl: "http://192.168.1.5/api",
      headers: { "x-api-token": "pw" },
    });
  });

  it("talks to the cloud proxy over https with a bearer token", () => {
    assert.deepEqual(resolveBusyBarEndpoint({ address: "api.busy.app", token: "tok" }), {
      baseUrl: "https://api.busy.app/busybar",
      headers: { authorization: "Bearer tok" },
    });
  });
});
