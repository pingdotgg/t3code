import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ presentationsAtom: null as unknown }));

vi.mock("../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make({ isReady: true }),
      networkStatusValueAtom: Atom.make("online"),
    },
  };
});
vi.mock("./presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  mocks.presentationsAtom = Atom.make(new Map());
  return { environmentPresentations: { presentationsAtom: mocks.presentationsAtom } };
});
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/peerLinks", () => ({
  createPeerLinkEnvironmentAtoms: () => ({ names: () => ({}) }),
}));
vi.mock("./relay", () => ({ relayEnvironmentDiscovery: {} }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => () => {} }));
vi.mock("./query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, isPending: false, refresh: () => {} }),
}));

import { useLinkedEnvironments } from "./peerLinks";

it("a message without thread links does not re-render when an environment's connection changes", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  const root = createRoot(document.createElement("div"));
  const onRender = vi.fn();
  function Probe() {
    onRender();
    useLinkedEnvironments(null);
    return null;
  }
  act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    ),
  );
  const atom = mocks.presentationsAtom as Atom.Writable<Map<string, unknown>>;
  act(() => registry.set(atom, new Map()));
  act(() => registry.set(atom, new Map()));
  act(() => root.unmount());
  expect(onRender).toHaveBeenCalledTimes(1);
});
