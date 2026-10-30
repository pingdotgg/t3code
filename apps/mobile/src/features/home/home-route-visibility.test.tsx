import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";

// The Thread in the detail column is the focused route on iPad split view.
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ isFocused: () => false }),
}));

import {
  recordHomeTransitionEnd,
  recordHomeTransitionStart,
  useAtomValueWhileVisible,
  useHomeRouteVisible,
} from "./home-route-visibility";

const shellsAtom = Atom.make(0).pipe(Atom.keepAlive);

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  let latest: number | undefined;
  function Probe() {
    const visible = useHomeRouteVisible();
    const value = useAtomValueWhileVisible(shellsAtom, visible);
    useLayoutEffect(() => {
      latest = value;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const sidebar = {
    presented: true,
    selectedThreadKey: "env-1:thread-1",
    selectedPullRequestKey: null,
  };
  return {
    registry,
    get latest() {
      return latest;
    },
    showHome() {
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <NativePrimaryColumnContext value={sidebar}>
              <Probe />
            </NativePrimaryColumnContext>
          </RegistryContext.Provider>,
        ),
      );
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
    },
  };
}

it("keeps the sidebar thread list live after switching tabs beside a focused Thread", () => {
  using home = setup();
  // The primary column appearing is the only navigation event Home gets on iPad.
  recordHomeTransitionStart(false);
  home.showHome();
  act(() => home.registry.set(shellsAtom, 1));
  expect(home.latest).toBe(1);

  // Chats → PRs → Chats: Chats' column will-appear, then the PRs column's did-disappear.
  act(() => {
    recordHomeTransitionEnd(true);
    recordHomeTransitionStart(false);
    recordHomeTransitionEnd(true);
  });
  act(() => home.registry.set(shellsAtom, 2));

  expect(home.latest, "new thread shells reach the sidebar list").toBe(2);
});
