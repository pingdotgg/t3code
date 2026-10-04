// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Listener = (event: { readonly data?: { readonly closing: boolean } }) => void;

const harness = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  const state = { focused: true };
  return {
    state,
    listeners,
    navigation: {
      isFocused: () => state.focused,
      addListener(type: string, listener: Listener) {
        let set = listeners.get(type);
        if (set === undefined) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(listener);
        return () => set.delete(listener);
      },
    },
    emit(type: string, data?: { readonly closing: boolean }) {
      for (const listener of listeners.get(type) ?? []) listener({ data });
    },
  };
});

vi.mock("@react-navigation/native", () => ({
  useNavigation: () => harness.navigation,
}));

import { useAtomValueWhileVisible, useHomeRouteVisible } from "./home-route-visibility";

const shellsAtom = Atom.make(0).pipe(Atom.keepAlive);
let registry: AtomRegistry.AtomRegistry;
let root: Root | null = null;
// Value of every committed render, the work a shell update costs on device.
let renders: Array<{ readonly visible: boolean; readonly value: number }> = [];

function Probe() {
  const visible = useHomeRouteVisible();
  const value = useAtomValueWhileVisible(shellsAtom, visible);
  useEffect(() => {
    renders.push({ visible, value });
  });
  return null;
}

function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  act(() =>
    root!.render(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    ),
  );
}

function stream(count: number) {
  for (let index = 0; index < count; index += 1) {
    act(() => registry.update(shellsAtom, (value) => value + 1));
  }
}

function pushThread() {
  act(() => harness.emit("transitionStart", { closing: true }));
  act(() => harness.emit("transitionEnd", { closing: true }));
}

beforeEach(() => {
  registry = AtomRegistry.make();
  harness.listeners.clear();
  harness.state.focused = true;
  renders = [];
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  registry.dispose();
});

describe("Home route visibility", () => {
  it("re-renders for every shell update while Home is visible", () => {
    mount();
    stream(20);
    expect(renders.at(-1)).toEqual({ visible: true, value: 20 });
    expect(renders).toHaveLength(21);
  });

  it("stays live until the covering Thread finishes its push animation", () => {
    mount();
    act(() => harness.emit("transitionStart", { closing: true }));
    stream(3);
    expect(renders.at(-1)).toEqual({ visible: true, value: 3 });
  });

  it("does no work for shell updates while a Thread covers Home", () => {
    mount();
    stream(2);
    pushThread();
    const before = renders.length;
    stream(600);
    expect(renders.length - before).toBe(0);
    expect(renders.at(-1)).toEqual({ visible: false, value: 2 });
  });

  it("shows the freshest list as soon as a back swipe starts revealing Home", () => {
    mount();
    pushThread();
    stream(50);
    act(() => harness.emit("transitionStart", { closing: false }));
    expect(renders.at(-1)).toEqual({ visible: true, value: 50 });
    stream(1);
    expect(renders.at(-1)).toEqual({ visible: true, value: 51 });
  });

  it("refreshes on focus when no appear event arrives", () => {
    mount();
    pushThread();
    stream(5);
    act(() => harness.emit("focus"));
    expect(renders.at(-1)).toEqual({ visible: true, value: 5 });
  });

  it("starts hidden when a deep link mounts Home under its Thread", () => {
    harness.state.focused = false;
    act(() => registry.set(shellsAtom, 7));
    mount();
    stream(10);
    expect(renders).toEqual([{ visible: false, value: 7 }]);
    act(() => harness.emit("transitionStart", { closing: false }));
    expect(renders.at(-1)).toEqual({ visible: true, value: 17 });
  });
});
