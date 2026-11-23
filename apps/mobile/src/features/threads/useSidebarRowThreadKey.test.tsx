import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { environmentThreadShells } from "../../state/threads";
import { makeThreadShellFixture } from "../../test-fixtures";
import { useSidebarRowThreadKey } from "./useSidebarRowThreadKey";

vi.mock("../../state/threads", async () => {
  const { Atom: ReactivityAtom } = await import("effect/reactivity");
  return {
    environmentThreadShells: {
      quietThreadShellsAtom: ReactivityAtom.make<readonly EnvironmentThreadShell[]>([]).pipe(
        ReactivityAtom.keepAlive,
      ),
    },
  };
});

const quietThreadShellsAtom = environmentThreadShells.quietThreadShellsAtom as Atom.Writable<
  readonly EnvironmentThreadShell[]
>;

describe("useSidebarRowThreadKey", () => {
  it("does not re-render on shell updates when no thread is selected", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };

    const envId = EnvironmentId.make("env-1");
    registry.set(quietThreadShellsAtom, [
      makeThreadShellFixture({ environmentId: envId, id: ThreadId.make("thread-1"), title: "One" }),
    ]);

    const seen: Array<string | null> = [];
    function Probe() {
      const value = useSidebarRowThreadKey(null);
      useLayoutEffect(() => {
        seen.push(value);
      });
      return null;
    }

    const root = createRoot(document.createElement("div"));
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <Probe />
        </RegistryContext>,
      ),
    );
    expect(seen).toEqual([null]);

    await act(async () => {
      registry.set(quietThreadShellsAtom, [
        makeThreadShellFixture({
          environmentId: envId,
          id: ThreadId.make("thread-1"),
          title: "One (updated)",
        }),
        makeThreadShellFixture({
          environmentId: envId,
          id: ThreadId.make("thread-2"),
          title: "Two",
        }),
      ]);
    });

    expect(seen).toEqual([null]);
  });

  it("skips re-renders on unrelated shell updates and updates when the listed ancestor changes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };

    const envId = EnvironmentId.make("env-1");
    const parentId = ThreadId.make("thread-parent");
    const childId = ThreadId.make("thread-child");
    const unrelatedId = ThreadId.make("thread-other");
    const parentKey = scopedThreadKey(envId, parentId);
    const childKey = scopedThreadKey(envId, childId);

    const parentThread = makeThreadShellFixture({
      environmentId: envId,
      id: parentId,
      title: "Parent",
    });
    const childThread = makeThreadShellFixture({
      environmentId: envId,
      id: childId,
      title: "Delegated child",
      delegatedFrom: { environmentId: envId, threadId: parentId, title: "Parent" },
    });
    const unrelatedThread = makeThreadShellFixture({
      environmentId: envId,
      id: unrelatedId,
      title: "Other v1",
    });

    registry.set(quietThreadShellsAtom, [parentThread, childThread, unrelatedThread]);

    const seen: Array<string | null> = [];
    function Probe(props: { openThreadKey: string | null }) {
      const value = useSidebarRowThreadKey(props.openThreadKey);
      useLayoutEffect(() => {
        seen.push(value);
      });
      return null;
    }

    const root = createRoot(document.createElement("div"));
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <Probe openThreadKey={childKey} />
        </RegistryContext>,
      ),
    );
    expect(seen).toEqual([parentKey]);

    // An unrelated shell update keeps the resolved ancestor key identical -> 0 re-renders.
    await act(async () => {
      registry.set(quietThreadShellsAtom, [
        parentThread,
        childThread,
        makeThreadShellFixture({
          environmentId: envId,
          id: unrelatedId,
          title: "Other v2",
        }),
      ]);
    });
    expect(seen).toEqual([parentKey]);

    // Archiving the parent causes the delegated child to own its own sidebar row -> updates.
    await act(async () => {
      registry.set(quietThreadShellsAtom, [
        { ...parentThread, archivedAt: "2026-01-02T00:00:00.000Z" },
        childThread,
        unrelatedThread,
      ]);
    });
    expect(seen).toEqual([parentKey, childKey]);
  });

  it("updates cleanly when switching openThreadKey on a mounted component", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };

    const envId = EnvironmentId.make("env-1");
    const parentId = ThreadId.make("thread-parent");
    const childId = ThreadId.make("thread-child");
    const otherId = ThreadId.make("thread-other");
    const parentKey = scopedThreadKey(envId, parentId);
    const childKey = scopedThreadKey(envId, childId);
    const otherKey = scopedThreadKey(envId, otherId);

    registry.set(quietThreadShellsAtom, [
      makeThreadShellFixture({ environmentId: envId, id: parentId, title: "Parent" }),
      makeThreadShellFixture({
        environmentId: envId,
        id: childId,
        title: "Delegated child",
        delegatedFrom: { environmentId: envId, threadId: parentId, title: "Parent" },
      }),
      makeThreadShellFixture({ environmentId: envId, id: otherId, title: "Other" }),
    ]);

    const seen: Array<string | null> = [];
    function Probe(props: { openThreadKey: string | null }) {
      const value = useSidebarRowThreadKey(props.openThreadKey);
      useLayoutEffect(() => {
        seen.push(value);
      });
      return null;
    }

    const root = createRoot(document.createElement("div"));
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    const renderKey = (openThreadKey: string | null) =>
      act(async () =>
        root.render(
          <RegistryContext value={registry}>
            <Probe openThreadKey={openThreadKey} />
          </RegistryContext>,
        ),
      );

    await renderKey(null);
    await renderKey(childKey);
    await renderKey(otherKey);
    await renderKey(null);

    expect(seen).toEqual([null, parentKey, otherKey, null]);

    // After switching back to null, shell updates do not re-render Probe.
    await act(async () => {
      registry.set(quietThreadShellsAtom, [
        makeThreadShellFixture({ environmentId: envId, id: otherId, title: "Other updated" }),
      ]);
    });
    expect(seen).toEqual([null, parentKey, otherKey, null]);
  });
});
