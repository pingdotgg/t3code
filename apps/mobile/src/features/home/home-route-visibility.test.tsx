import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import {
  NativePrimaryColumnContext,
  NativeWorkspaceTabActivityContext,
} from "../../native/v5-workspace-context";

// The Thread in the detail column is the focused route on iPad split view.
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ isFocused: () => false }),
}));

import {
  recordHomeFocus,
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
    /** A phone has no primary column: Home is the root page of its tab's slot. */
    showHomeInTabSlot(active: boolean) {
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <NativeWorkspaceTabActivityContext value={{ active, isActive: () => active }}>
              <Probe />
            </NativeWorkspaceTabActivityContext>
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
    recordHomeTransitionEnd(true, false);
    recordHomeTransitionStart(false);
    recordHomeTransitionEnd(true, false);
  });
  act(() => home.registry.set(shellsAtom, 2));

  expect(home.latest, "new thread shells reach the sidebar list").toBe(2);
});

// Each phone tab slot shows its own copy of the Home route. PRs keeps Home focused; Settings
// is a route of its own.
it.each([
  { tab: "PRs", homeFocusedUnderTab: true },
  { tab: "Settings", homeFocusedUnderTab: false },
])(
  "keeps the phone thread list live after a round trip through $tab",
  ({ homeFocusedUnderTab }) => {
    using home = setup();
    recordHomeFocus();
    home.showHomeInTabSlot(true);
    act(() => home.registry.set(shellsAtom, 1));
    expect(home.latest).toBe(1);

    // To the other tab: its slot will-appear, then the Chats slot's did-disappear.
    act(() => {
      recordHomeTransitionStart(false);
      recordHomeTransitionEnd(true, homeFocusedUnderTab);
    });
    home.showHomeInTabSlot(false);
    act(() => home.registry.set(shellsAtom, 2));
    expect(home.latest, "the list under another tab holds its rows").toBe(1);

    // Back to Chats: its slot will-appear, then the other slot's did-disappear comes last.
    act(() => {
      recordHomeFocus();
      recordHomeTransitionStart(false);
      recordHomeTransitionEnd(true, true);
    });
    home.showHomeInTabSlot(true);
    act(() => home.registry.set(shellsAtom, 3));
    expect(home.latest, "a server rename reaches the list").toBe(3);

    // A pushed Thread takes the focus and still stops the list.
    act(() => recordHomeTransitionEnd(true, false));
    act(() => home.registry.set(shellsAtom, 4));
    expect(home.latest, "the list under a Thread holds its rows").toBe(3);
  },
);
