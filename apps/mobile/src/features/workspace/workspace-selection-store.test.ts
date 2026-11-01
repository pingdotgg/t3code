import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

type FamilyRead = AsyncResult.AsyncResult<
  { readonly threads: ReadonlyArray<{ readonly id: string }> },
  Error
>;

const harness = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    family: Atom.make<FamilyRead>(AsyncResult.initial(true)).pipe(Atom.keepAlive),
    mounts: Atom.make<ReadonlyArray<string>>([]).pipe(Atom.keepAlive),
  };
});

vi.mock("react-native", () => ({
  Platform: { OS: "ios", isPad: true },
  Dimensions: { get: () => ({ width: 1024, height: 768 }) },
  AppState: { addEventListener: () => undefined },
}));
vi.mock("expo-linking", () => ({ createURL: (path: string) => `t3code://${path}` }));
vi.mock("../../persistence/imperative", () => ({
  loadPreferences: () => Promise.resolve({}),
  savePreferencesPatch: () => Promise.resolve(),
}));
vi.mock("../../native/native-layout-metrics", () => ({
  currentNativeLayoutMetrics: () => null,
  firstNativeLayoutMetrics: () => Promise.resolve(null),
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { catalogValueAtom: Atom.make({ isReady: true }) },
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: Atom.make(new Map([["env", {}]])) },
}));
// A loaded snapshot whose shell rows leave the remembered chat out. As in `threadFamilies`, a
// mounted family's settled rows join the thread index.
vi.mock("../../state/threads", () => ({
  startOpeningEnvironmentThread: () => undefined,
  threadEnvironment: { snapshotAtom: () => Atom.make({ threads: [] }) },
  environmentThreadShells: {
    environmentThreadIndexAtom: () =>
      Atom.make((get) => {
        const family = get(harness.family);
        const rows =
          get(harness.mounts).length > 0 && AsyncResult.isSuccess(family)
            ? family.value.threads
            : [];
        return new Map(rows.map((row) => [row.id, row]));
      }),
  },
  threadFamilies: {
    familyAtom: () => harness.family,
    mount: (registry: typeof appAtomRegistry, environmentId: string, threadId: string) => {
      const key = `${environmentId}/${threadId}`;
      registry.set(harness.mounts, [...registry.get(harness.mounts), key]);
      return () =>
        registry.set(
          harness.mounts,
          registry.get(harness.mounts).filter((mounted) => mounted !== key),
        );
    },
    // A refresh puts the read back in flight, as `registry.refresh` does on the real query.
    refresh: (registry: typeof appAtomRegistry) =>
      registry.set(harness.family, AsyncResult.waiting(registry.get(harness.family))),
  },
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { recordWorkspaceSelections, workspaceSelectionCheck } from "./workspace-selection-store";

function remember(threadId: string) {
  recordWorkspaceSelections({
    stale: false,
    type: "stack",
    key: "root",
    index: 0,
    routeNames: ["Thread"],
    routes: [
      { key: `Thread-${threadId}`, name: "Thread", params: { environmentId: "env", threadId } },
    ],
  });
}

describe("workspaceSelectionCheck.thread", () => {
  it.each([
    {
      name: "family read pending",
      family: AsyncResult.initial(true),
      expected: true,
      readInFlight: true,
    },
    {
      name: "family read failed",
      family: AsyncResult.fail(new Error("read failed")),
      expected: true,
      readInFlight: true,
    },
    {
      name: "settled family holds the chat",
      family: AsyncResult.success({ threads: [{ id: "thread-a" }] }),
      expected: true,
      readInFlight: false,
    },
    {
      name: "settled family without the chat",
      family: AsyncResult.success({ threads: [] }),
      expected: false,
      readInFlight: false,
    },
  ])("remembered chat missing from the shell rows: $name", (row) => {
    remember("thread-a");
    appAtomRegistry.set(harness.family, row.family);
    expect(workspaceSelectionCheck.thread({ environmentId: "env", threadId: "thread-a" })).toBe(
      row.expected,
    );
    expect(appAtomRegistry.get(harness.family).waiting).toBe(row.readInFlight);
  });

  it("keeps only the remembered chat's family mounted", () => {
    remember("thread-a");
    remember("thread-b");
    expect(appAtomRegistry.get(harness.mounts)).toEqual(["env/thread-b"]);
  });
});
