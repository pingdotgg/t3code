import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";

import {
  addPendingProcessSignal,
  connectedDiagnosticsData,
  diagnosticsConnectionNotice,
  pendingProcessSignalPids,
  removePendingProcessSignal,
  resolveDiagnosticsEnvironmentId,
  type PendingProcessSignal,
} from "./DiagnosticsSettings.logic";

const PRIMARY = EnvironmentId.make("primary");
const ACTIVE = EnvironmentId.make("active");
const SELECTED = EnvironmentId.make("selected");

describe("resolveDiagnosticsEnvironmentId", () => {
  it("preserves an explicit available selection", () => {
    assert.equal(
      resolveDiagnosticsEnvironmentId({
        selectedEnvironmentId: SELECTED,
        primaryEnvironmentId: PRIMARY,
        activeEnvironmentId: ACTIVE,
        availableEnvironmentIds: [PRIMARY, ACTIVE, SELECTED],
      }),
      SELECTED,
    );
  });

  it("defaults to the primary environment when one is available", () => {
    assert.equal(
      resolveDiagnosticsEnvironmentId({
        selectedEnvironmentId: null,
        primaryEnvironmentId: PRIMARY,
        activeEnvironmentId: ACTIVE,
        availableEnvironmentIds: [ACTIVE, PRIMARY],
      }),
      PRIMARY,
    );
  });

  it("uses the active environment when there is no primary environment", () => {
    assert.equal(
      resolveDiagnosticsEnvironmentId({
        selectedEnvironmentId: null,
        primaryEnvironmentId: null,
        activeEnvironmentId: ACTIVE,
        availableEnvironmentIds: [SELECTED, ACTIVE],
      }),
      ACTIVE,
    );
  });

  it("falls back to the first available environment", () => {
    assert.equal(
      resolveDiagnosticsEnvironmentId({
        selectedEnvironmentId: null,
        primaryEnvironmentId: null,
        activeEnvironmentId: null,
        availableEnvironmentIds: [SELECTED, ACTIVE],
      }),
      SELECTED,
    );
  });

  it("recovers when the explicit selection is no longer available", () => {
    assert.equal(
      resolveDiagnosticsEnvironmentId({
        selectedEnvironmentId: SELECTED,
        primaryEnvironmentId: PRIMARY,
        activeEnvironmentId: ACTIVE,
        availableEnvironmentIds: [PRIMARY, ACTIVE],
      }),
      PRIMARY,
    );
  });

  it("returns null when no environments are available", () => {
    assert.isNull(
      resolveDiagnosticsEnvironmentId({
        selectedEnvironmentId: SELECTED,
        primaryEnvironmentId: PRIMARY,
        activeEnvironmentId: ACTIVE,
        availableEnvironmentIds: [],
      }),
    );
  });
});

describe("diagnosticsConnectionNotice", () => {
  it("returns null while the environment is connected", () => {
    assert.isNull(
      diagnosticsConnectionNotice({ phase: "connected", label: "Laptop", error: null }),
    );
  });

  it("explains that an offline environment cannot report diagnostics", () => {
    assert.equal(
      diagnosticsConnectionNotice({ phase: "offline", label: "Laptop", error: null }),
      "Laptop is offline. Diagnostics load once it reconnects.",
    );
  });

  it("explains that a never-connected environment cannot report diagnostics", () => {
    assert.equal(
      diagnosticsConnectionNotice({ phase: "available", label: "Laptop", error: null }),
      "Laptop is not connected. Diagnostics load once it connects.",
    );
  });

  it("includes the failure reason while reconnecting", () => {
    assert.equal(
      diagnosticsConnectionNotice({
        phase: "reconnecting",
        label: "Laptop",
        error: "socket hang up",
      }),
      "Reconnecting to Laptop... Reason: socket hang up",
    );
  });

  it("reports a blocked connection", () => {
    assert.equal(
      diagnosticsConnectionNotice({ phase: "error", label: "Laptop", error: "unauthorized" }),
      "Could not connect to Laptop. Reason: unauthorized",
    );
  });

  it("reports an initial connection attempt", () => {
    assert.equal(
      diagnosticsConnectionNotice({ phase: "connecting", label: "Laptop", error: null }),
      "Connecting to Laptop...",
    );
  });
});

describe("connectedDiagnosticsData", () => {
  it("hides cached results after the selected environment disconnects", () => {
    const cached = { processCount: 3 };

    assert.strictEqual(connectedDiagnosticsData(true, cached), cached);
    assert.isNull(connectedDiagnosticsData(false, cached));
  });
});

describe("pending process signals", () => {
  it("tracks pending signals per environment and pid", () => {
    const pending = addPendingProcessSignal(
      addPendingProcessSignal([], { environmentId: PRIMARY, pid: 100 }),
      { environmentId: ACTIVE, pid: 200 },
    );

    assert.deepEqual([...pendingProcessSignalPids(pending, PRIMARY)], [100]);
    assert.deepEqual([...pendingProcessSignalPids(pending, ACTIVE)], [200]);
    assert.deepEqual([...pendingProcessSignalPids(pending, SELECTED)], []);
    assert.deepEqual([...pendingProcessSignalPids(pending, null)], []);
  });

  it("does not duplicate a signal that is already pending", () => {
    const pending = addPendingProcessSignal([{ environmentId: PRIMARY, pid: 100 }], {
      environmentId: PRIMARY,
      pid: 100,
    });

    assert.equal(pending.length, 1);
  });

  it("keeps the same pid pending in another environment", () => {
    const pending = addPendingProcessSignal(
      addPendingProcessSignal([], { environmentId: PRIMARY, pid: 100 }),
      { environmentId: ACTIVE, pid: 100 },
    );

    assert.deepEqual([...pendingProcessSignalPids(pending, PRIMARY)], [100]);
    assert.deepEqual([...pendingProcessSignalPids(pending, ACTIVE)], [100]);
  });

  it("only clears the completed request, leaving other environments pending", () => {
    const pending = addPendingProcessSignal(
      addPendingProcessSignal([], { environmentId: PRIMARY, pid: 100 }),
      { environmentId: ACTIVE, pid: 200 },
    );

    const remaining = removePendingProcessSignal(pending, { environmentId: PRIMARY, pid: 100 });

    assert.deepEqual([...pendingProcessSignalPids(remaining, PRIMARY)], []);
    assert.deepEqual([...pendingProcessSignalPids(remaining, ACTIVE)], [200]);
  });

  it("ignores completions for signals that are no longer pending", () => {
    const pending: ReadonlyArray<PendingProcessSignal> = [{ environmentId: PRIMARY, pid: 100 }];

    assert.strictEqual(
      removePendingProcessSignal(pending, { environmentId: ACTIVE, pid: 100 }),
      pending,
    );
  });
});
