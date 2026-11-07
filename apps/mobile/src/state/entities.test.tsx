import { RegistryContext } from "@effect/atom-react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

vi.mock("./atom-registry", () => ({ appAtomRegistry: AtomRegistry.make() }));
vi.mock("./projects", () => ({ environmentProjects: {} }));
vi.mock("./server", () => ({
  environmentServerConfigsAtom: Atom.make(new Map()),
  serverEnvironment: {},
}));
vi.mock("./assets", () => ({ projectFaviconUrlAtom: vi.fn() }));
vi.mock("../native/ProjectChipIconImages", () => ({
  projectGlyphImageAtom: vi.fn(),
  projectGlyphKey: vi.fn(),
}));
vi.mock("./threads", () => {
  const shell = Atom.make<{ title: string } | null>(null);
  return {
    environmentThreadDetails: {},
    environmentThreadShells: { threadShellAtom: () => shell },
    threadFamilies: {
      mount: (registry: AtomRegistry.AtomRegistry) => {
        registry.set(shell, { title: "Child result" });
        return () => registry.set(shell, null);
      },
    },
  };
});

import { appAtomRegistry } from "./atom-registry";
import { useLiveThreadLinkLabels } from "./entities";
import { environmentThreadShells } from "./threads";

it("keeps a linked child title mounted until the message stops citing it", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  let renders = 0;
  function Probe({ text }: { text: string }) {
    if (++renders > 20) throw new Error("Thread title subscription loop");
    return useLiveThreadLinkLabels(text, EnvironmentId.make("local"));
  }
  try {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <Probe text="[Child](t3-thread://v2/local/child)" />
        </RegistryContext.Provider>,
      ),
    );
    expect(container.textContent).toBe("[Child result](t3-thread://v2/local/child)");
    expect(renders).toBeLessThan(20);
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <Probe text="No link" />
        </RegistryContext.Provider>,
      ),
    );
    expect(container.textContent).toBe("No link");
    expect(
      appAtomRegistry.get(
        environmentThreadShells.threadShellAtom({
          environmentId: EnvironmentId.make("local"),
          threadId: ThreadId.make("child"),
        }),
      ),
    ).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
