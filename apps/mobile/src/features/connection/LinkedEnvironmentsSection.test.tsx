import { RegistryContext } from "@effect/atom-react";
import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

// Each listing probes every linked machine, so the test counts the fetches it starts and cuts.
const fetches = vi.hoisted(() => ({
  started: 0,
  interrupted: 0,
  gate: Promise.resolve(),
  open: () => {},
}));

vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(
    realpathSync(require.resolve("@react-navigation/native/package.json")),
  );
  // Use the shipped focus hook without importing the React Native view layer.
  const { NavigationContext, useFocusEffect }: typeof import("@react-navigation/native") =
    nativeRequire("@react-navigation/core");
  return { NavigationContext, useFocusEffect };
});
const appState = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: "change", listener: (state: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
  View: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => ({
    environment: { capabilities: { peerLinks: true } },
    settings: { linkedEnvironmentsEnabled: true },
  }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/peerLinks", async () => {
  const { Atom } = await import("effect/reactivity");
  const EffectModule = await import("effect/Effect");
  // Waits for the gate, as a list waits on its slowest linked machine.
  const list = Atom.make(
    EffectModule.gen(function* () {
      fetches.started += 1;
      yield* EffectModule.promise(() => fetches.gate);
      return { links: [] };
    }).pipe(
      EffectModule.onInterrupt(() =>
        EffectModule.sync(() => {
          fetches.interrupted += 1;
        }),
      ),
    ),
  );
  return { peerLinkEnvironment: { list: () => list } };
});

import { LinkedEnvironmentsSection } from "./LinkedEnvironmentsSection";

function createNavigation() {
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  let focused = true;
  return {
    value: {
      isFocused: () => focused,
      addListener: (event: keyof typeof listeners, listener: () => void) => {
        listeners[event].add(listener);
        return () => listeners[event].delete(listener);
      },
    } as unknown as NavigationProp<ParamListBase>,
    focus(next: boolean) {
      focused = next;
      act(() => {
        for (const listener of listeners[next ? "focus" : "blur"]) listener();
      });
    },
  };
}

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetches.started = 0;
  fetches.interrupted = 0;
  fetches.gate = new Promise((resolve) => {
    fetches.open = resolve;
  });
  const registry = AtomRegistry.make();
  const root = createRoot(document.createElement("div"));
  const navigation = createNavigation();
  act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <NavigationContext.Provider value={navigation.value}>
          <LinkedEnvironmentsSection
            environmentId={EnvironmentId.make("mac")}
            environmentLabel="Mac"
          />
        </NavigationContext.Provider>
      </RegistryContext.Provider>,
    ),
  );
  return {
    focus: navigation.focus,
    moveApp: (state: "active" | "background") =>
      act(() => {
        for (const listener of appState.listeners) listener(state);
      }),
    settle: () =>
      act(async () => {
        fetches.open();
        await fetches.gate;
      }),
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
    },
  };
}

it("asks again on focus only once the list it is waiting for has answered", async () => {
  using screen = setup();
  // The first focus comes while the first fetch runs, which must not be cut and restarted.
  expect(fetches).toMatchObject({ started: 1, interrupted: 0 });
  screen.focus(false);
  screen.focus(true);
  expect(fetches).toMatchObject({ started: 1, interrupted: 0 });

  await screen.settle();
  screen.focus(false);
  screen.focus(true);
  expect(fetches).toMatchObject({ started: 2, interrupted: 0 });
});

it("asks again when the app comes back to the front on this screen", async () => {
  using screen = setup();
  await screen.settle();
  expect(fetches).toMatchObject({ started: 1, interrupted: 0 });
  fetches.gate = new Promise((resolve) => {
    fetches.open = resolve;
  });

  screen.moveApp("background");
  screen.moveApp("active");
  expect(fetches).toMatchObject({ started: 2, interrupted: 0 });

  // Coming back while that answer is still out must not cut it and start again.
  screen.moveApp("background");
  screen.moveApp("active");
  expect(fetches).toMatchObject({ started: 2, interrupted: 0 });
});
