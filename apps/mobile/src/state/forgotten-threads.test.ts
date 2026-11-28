import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type OrchestrationV2ShellSnapshot, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const shellStates = vi.hoisted(() => new Map<string, unknown>());
const catalog = vi.hoisted(() => ({ atom: null as unknown }));

vi.mock("./shell", () => ({
  environmentShell: {
    stateValueAtom: (environmentId: string) => shellStates.get(environmentId),
  },
}));

vi.mock("../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  catalog.atom = Atom.make({ isReady: true, entries: new Map() }).pipe(Atom.keepAlive);
  return { environmentCatalog: { catalogValueAtom: catalog.atom } };
});

import { appAtomRegistry } from "./atom-registry";
import { forgetThread, withoutForgottenThreads } from "./forgotten-threads";

const environmentId = EnvironmentId.make("forgotten-threads-env");
const kept = ThreadId.make("kept");
const gone = ThreadId.make("gone");

const shellState = Atom.make({ generation: 0 } as EnvironmentShellState).pipe(Atom.keepAlive);
shellStates.set(environmentId, shellState);
const snapshot = Atom.make({
  threads: [{ id: kept }, { id: gone }],
} as unknown as OrchestrationV2ShellSnapshot).pipe(Atom.keepAlive);
const visible = withoutForgottenThreads(() => snapshot)(environmentId);
const visibleIds = () => appAtomRegistry.get(visible)?.threads.map((thread) => thread.id);
const catalogAtom = catalog.atom as Atom.Writable<{
  isReady: boolean;
  entries: Map<string, unknown>;
}>;
appAtomRegistry.set(catalogAtom, { isReady: true, entries: new Map([[environmentId, {}]]) });
const setGeneration = (generation: number) =>
  appAtomRegistry.set(shellState, { generation } as EnvironmentShellState);

describe("withoutForgottenThreads", () => {
  it("hides a forgotten thread until the shell generation changes, and only once", () => {
    const unmount = appAtomRegistry.mount(visible);
    expect(visibleIds()).toEqual([kept, gone]);

    forgetThread(environmentId, gone);
    expect(visibleIds()).toEqual([kept]);

    setGeneration(7);
    expect(visibleIds()).toEqual([kept, gone]);

    // A rebuilt shell returns to cached generation 0; the expired entry must stay expired.
    setGeneration(0);
    expect(visibleIds()).toEqual([kept, gone]);
    unmount();
  });

  it("expires a forgotten thread when its environment is removed", () => {
    const unmount = appAtomRegistry.mount(visible);
    forgetThread(environmentId, gone);
    expect(visibleIds()).toEqual([kept]);

    appAtomRegistry.set(catalogAtom, { isReady: true, entries: new Map() });
    expect(visibleIds()).toEqual([kept, gone]);
    unmount();
  });
});
