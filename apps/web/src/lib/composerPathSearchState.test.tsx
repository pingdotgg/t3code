import { RegistryContext } from "@effect/atom-react";
import type { ComposerPathSearchTarget } from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, type ProjectSearchEntriesResult } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useComposerPathSearch } from "./composerPathSearchState";

vi.mock("../state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("../state/projects", () => ({
  projectEnvironment: { searchEntries: (target: unknown) => searchAtom(target) },
  projectContentSearch: vi.fn(),
}));

const searches = new Map<
  string,
  Atom.Writable<AsyncResult.AsyncResult<ProjectSearchEntriesResult>>
>();
function searchAtom(target: unknown) {
  const key = JSON.stringify(target);
  let atom = searches.get(key);
  if (!atom) {
    atom = Atom.make<AsyncResult.AsyncResult<ProjectSearchEntriesResult>>(
      AsyncResult.initial(true),
    );
    searches.set(key, atom);
  }
  return atom;
}

let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer | undefined;
let latest: ReturnType<typeof useComposerPathSearch>;
const alpha = { environmentId: EnvironmentId.make("local"), cwd: "/repo", query: "alpha" };

function Probe({
  target,
  onResult,
}: {
  target: ComposerPathSearchTarget;
  onResult: (result: ReturnType<typeof useComposerPathSearch>) => void;
}) {
  onResult(useComposerPathSearch(target));
  return null;
}

async function render(target: ComposerPathSearchTarget) {
  await act(() => {
    const element = (
      <RegistryContext.Provider value={registry}>
        <Probe
          target={target}
          onResult={(result) => {
            latest = result;
          }}
        />
      </RegistryContext.Provider>
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}

async function resolve(target: ComposerPathSearchTarget, path: string) {
  await act(() => {
    registry.set(
      searchAtom({
        environmentId: target.environmentId,
        input: { cwd: target.cwd, query: target.query, limit: 80 },
      }),
      AsyncResult.success({ entries: [{ path, kind: "file" }], truncated: false }),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  searches.clear();
  registry = AtomRegistry.make();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  registry.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  ["query", { ...alpha, query: "beta" }],
  ["workspace", { ...alpha, cwd: "/other-repo" }],
  ["environment", { ...alpha, environmentId: EnvironmentId.make("remote") }],
])("keeps entries and their target stable while a new %s debounces", async (_name, target) => {
  await render(alpha);
  await resolve(alpha, "alpha.ts");
  expect(latest.entries).toEqual([{ path: "alpha.ts", kind: "file" }]);
  expect(latest.searchedTarget).toMatchObject(alpha);
  const entries = latest.entries;
  const searchedTarget = latest.searchedTarget;

  await render(target);
  expect(latest.isPending).toBe(true);
  expect(latest.entries).toBe(entries);
  expect(latest.searchedTarget).toBe(searchedTarget);
  expect(searches.size).toBe(1);

  await act(() => vi.advanceTimersByTime(119));
  expect(latest.entries).toBe(entries);
  expect(latest.searchedTarget).toBe(searchedTarget);
  expect(searches.size).toBe(1);

  await act(() => vi.advanceTimersByTime(1));
  expect(latest.isPending).toBe(true);
  expect(latest.entries).toEqual([]);
  expect(latest.searchedTarget).toMatchObject(target);
  expect(searches.size).toBe(2);

  await resolve(target, "beta.ts");
  expect(latest.entries).toEqual([{ path: "beta.ts", kind: "file" }]);
  expect(latest.searchedTarget).toMatchObject(target);
  expect(latest.isPending).toBe(false);
});
