import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { useWorkspaceDiff } from "./useWorkspaceDiff";

vi.mock("../state/review", () => ({
  reviewEnvironment: {
    diffPreview: ({ input }: { input: { cwd: string; baseRef?: string } }) =>
      Atom.make(AsyncResult.success({ cwd: input.cwd, baseRef: input.baseRef ?? "automatic" })),
  },
}));

it("keeps each repository's comparison base when switching between a filter and all repositories", async () => {
  const registry = AtomRegistry.make();
  const one = { path: "projects/one", name: "one", cwd: "/workspace/one", available: true };
  const two = { path: "projects/two", name: "two", cwd: "/workspace/two", available: true };
  const bases = { [one.cwd]: "release/one", [two.cwd]: "release/two" };
  let data: unknown[] = [];
  function Probe({ repositories }: { repositories: readonly (typeof one)[] }) {
    const result = useWorkspaceDiff(EnvironmentId.make("test"), repositories, bases, false);
    data = result.results.map((entry) => entry.data);
    return null;
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <RegistryContext.Provider value={registry}>
          <Probe repositories={[one]} />
        </RegistryContext.Provider>,
      );
    });
    expect(data).toEqual([{ cwd: one.cwd, baseRef: "release/one" }]);
    await act(async () => {
      renderer?.update(
        <RegistryContext.Provider value={registry}>
          <Probe repositories={[one, two]} />
        </RegistryContext.Provider>,
      );
    });
    expect(data).toEqual([
      { cwd: one.cwd, baseRef: "release/one" },
      { cwd: two.cwd, baseRef: "release/two" },
    ]);
  } finally {
    await act(async () => renderer?.unmount());
    registry.dispose();
    vi.unstubAllGlobals();
  }
});
