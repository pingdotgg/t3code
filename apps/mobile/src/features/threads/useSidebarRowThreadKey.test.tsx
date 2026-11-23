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
  it("re-renders only when the resolved row key changes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };

    const envId = EnvironmentId.make("env-1");
    const parentId = ThreadId.make("thread-parent");
    const childId = ThreadId.make("thread-child");
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
    const otherThread = (title: string) =>
      makeThreadShellFixture({ environmentId: envId, id: ThreadId.make("thread-other"), title });

    registry.set(quietThreadShellsAtom, [parentThread, childThread, otherThread("v1")]);

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
    const setShells = (shells: readonly EnvironmentThreadShell[]) =>
      act(async () => registry.set(quietThreadShellsAtom, shells));

    await renderKey(null);
    await setShells([parentThread, childThread, otherThread("v2")]);
    expect(seen).toEqual([null]);

    await renderKey(childKey);
    await setShells([parentThread, childThread, otherThread("v3")]);
    expect(seen).toEqual([null, parentKey]);

    await setShells([
      { ...parentThread, archivedAt: "2026-01-02T00:00:00.000Z" },
      childThread,
      otherThread("v3"),
    ]);
    expect(seen).toEqual([null, parentKey, childKey]);
  });
});
