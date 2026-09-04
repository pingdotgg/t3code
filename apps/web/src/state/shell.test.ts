import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createAllEnvironmentProjectSnapshotsReadyAtom } from "./shell";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

function shellState(status: EnvironmentShellState["status"]): EnvironmentShellState {
  return {
    status,
    snapshot:
      status === "empty"
        ? Option.none()
        : Option.some({
            snapshotSequence: 1,
            updatedAt: "2026-09-04T00:00:00.000Z",
            projects: [],
            threads: [],
          }),
    error: Option.none(),
  };
}

function catalogState(environmentIds: readonly EnvironmentId[]): EnvironmentCatalogState {
  return {
    isReady: true,
    entries: new Map(
      environmentIds.map((environmentId) => [
        environmentId,
        {
          target: new PrimaryConnectionTarget({
            environmentId,
            label: environmentId,
            httpBaseUrl: `https://${environmentId}.example.test`,
            wsBaseUrl: `wss://${environmentId}.example.test`,
          }),
          profile: Option.none(),
        },
      ]),
    ),
  };
}

function makeHarness() {
  const catalog = Atom.make<EnvironmentCatalogState>({ isReady: false, entries: new Map() });
  const shells = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<EnvironmentShellState>(shellState("empty")),
  );
  const ready = createAllEnvironmentProjectSnapshotsReadyAtom({
    catalogValueAtom: catalog,
    shellStateValueAtom: shells,
  });
  const registry = AtomRegistry.make();
  return { catalog, shells, ready, registry };
}

describe("project snapshot readiness", () => {
  it("does not clear a saved scope before catalog loading finishes", () => {
    const { catalog, ready, registry } = makeHarness();
    expect(registry.get(ready)).toBe(false);
    registry.set(catalog, catalogState([]));
    expect(registry.get(ready)).toBe(true);
    registry.dispose();
  });

  it("waits for live snapshots through offline startup and reconnect", () => {
    const { catalog, shells, ready, registry } = makeHarness();
    registry.set(catalog, catalogState([LOCAL, REMOTE]));
    registry.set(shells(LOCAL), shellState("live"));
    expect(registry.get(ready)).toBe(false);

    // An old cache and a reconnect in progress can both omit a real project.
    registry.set(shells(REMOTE), shellState("cached"));
    expect(registry.get(ready)).toBe(false);
    registry.set(shells(REMOTE), shellState("synchronizing"));
    expect(registry.get(ready)).toBe(false);
    registry.set(shells(REMOTE), shellState("live"));
    expect(registry.get(ready)).toBe(true);

    registry.set(shells(REMOTE), shellState("cached"));
    expect(registry.get(ready)).toBe(false);
    registry.set(shells(REMOTE), shellState("live"));
    expect(registry.get(ready)).toBe(true);
    registry.dispose();
  });

  it("stops waiting for an environment only when it leaves the catalog", () => {
    const { catalog, shells, ready, registry } = makeHarness();
    registry.set(catalog, catalogState([LOCAL, REMOTE]));
    registry.set(shells(LOCAL), shellState("live"));
    expect(registry.get(ready)).toBe(false);
    registry.set(catalog, catalogState([LOCAL]));
    expect(registry.get(ready)).toBe(true);
    registry.dispose();
  });
});
