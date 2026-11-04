import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadDetails: {},
    environmentThreadShells: {
      threadShellAtom: () => Atom.make(null),
      threadRefsAtom: Atom.make([]),
    },
  };
});
vi.mock("./projects", () => ({ environmentProjects: {} }));
vi.mock("./server", () => ({ environmentServerConfigsAtom: {}, serverEnvironment: {} }));
vi.mock("./assets", () => ({ projectFaviconUrlAtom: () => null }));
vi.mock("../native/ProjectChipIconImages", () => ({
  projectGlyphImageAtom: () => null,
  projectGlyphKey: () => "",
}));

import { resolveThreadLink } from "./entities";

it("opens an explicit thread destination even when the shell omits it", () => {
  const registry = AtomRegistry.make();
  const destination: ScopedThreadRef = {
    environmentId: EnvironmentId.make("archbook"),
    threadId: ThreadId.make("thread:delegated-task:mcp%3A1"),
  };
  try {
    expect(
      resolveThreadLink(
        registry.get.bind(registry),
        destination,
        EnvironmentId.make("another-environment"),
      ),
    ).toEqual(destination);
  } finally {
    registry.dispose();
  }
});
