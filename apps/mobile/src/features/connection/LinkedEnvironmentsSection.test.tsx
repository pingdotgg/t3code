import { RegistryContext } from "@effect/atom-react";
import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { ConfirmDialogRequest } from "../../components/ui/Dialog.types";

// Each listing probes every linked machine, so the test counts the fetches it starts and cuts.
const fetches = vi.hoisted(() => ({
  started: 0,
  interrupted: 0,
  gate: Promise.resolve(),
  open: () => {},
  links: [] as PeerLinkSummary[],
  error: null as string | null,
}));
const mocks = vi.hoisted(() => ({
  canUnlink: true,
  confirm: vi.fn<(request: ConfirmDialogRequest) => void>(),
  alert: vi.fn(),
  unlink: vi.fn(),
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
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ confirm: mocks.confirm, alert: mocks.alert }));
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
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.unlink }));
vi.mock("../../state/peerLinks", async () => {
  const { Atom } = await import("effect/reactivity");
  const EffectModule = await import("effect/Effect");
  const { TaggedError } = await import("effect/Data");
  class ListFailed extends TaggedError("ListFailed")<{ readonly message: string }> {}
  // Waits for the gate, as a list waits on its slowest linked machine.
  const list = Atom.make(
    EffectModule.gen(function* () {
      fetches.started += 1;
      yield* EffectModule.promise(() => fetches.gate);
      if (fetches.error !== null) return yield* new ListFailed({ message: fetches.error });
      return { links: fetches.links };
    }).pipe(
      EffectModule.onInterrupt(() =>
        EffectModule.sync(() => {
          fetches.interrupted += 1;
        }),
      ),
    ),
  );
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  return {
    peerLinkEnvironment: {
      list: () => list,
      unlink: { permissionAtom: () => (mocks.canUnlink ? allowed : denied) },
    },
  };
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

function setup(
  options: {
    readonly links?: PeerLinkSummary[];
    readonly error?: string;
    readonly canUnlink?: boolean;
  } = {},
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetches.started = 0;
  fetches.interrupted = 0;
  fetches.links = options.links ?? [];
  fetches.error = options.error ?? null;
  fetches.gate = new Promise((resolve) => {
    fetches.open = resolve;
  });
  mocks.canUnlink = options.canUnlink ?? true;
  mocks.confirm.mockReset();
  mocks.alert.mockReset();
  mocks.unlink.mockReset();
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  const root = createRoot(container);
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
    container,
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

const buildMachineLink: PeerLinkSummary = {
  environmentId: EnvironmentId.make("destination"),
  label: "Build machine",
  urls: ["https://build.example.com"],
  access: "approval-required",
  linkedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  expiresAt: DateTime.makeUnsafe("2099-10-01T00:00:00Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
};

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

it("lets mobile users forget an agent link only after confirmation and with destination-scoped permissions", async () => {
  {
    using screen = setup({ links: [buildMachineLink] });
    await screen.settle();
    const forget = screen.container.querySelector<HTMLButtonElement>("button");
    expect(forget).not.toBeNull();
    act(() => forget!.click());
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.confirm.mock.lastCall?.[0].message).toContain("Revoke");
    expect(mocks.confirm.mock.lastCall?.[0].message).toContain("Build machine");

    let resolve!: (value: ReturnType<typeof AsyncResult.success>) => void;
    mocks.unlink.mockReturnValueOnce(
      new Promise((finish) => {
        resolve = finish;
      }),
    );
    act(() => mocks.confirm.mock.lastCall![0].onConfirm());
    expect(forget!.disabled).toBe(true);
    expect(mocks.unlink).toHaveBeenCalledWith({
      environmentId: "mac",
      input: { environmentId: "destination" },
    });
    await act(async () => resolve(AsyncResult.success({ removed: true })));
    expect(forget!.disabled).toBe(false);
  }

  using readOnly = setup({ links: [buildMachineLink], canUnlink: false });
  await readOnly.settle();
  expect(readOnly.container.textContent).toContain("Build machine");
  expect(readOnly.container.querySelector("button")).toBeNull();
});

it("keeps a failed link read visible and lets the user retry", async () => {
  const error = "The environment is reconnecting.";
  using screen = setup({ error });
  await screen.settle();
  expect(screen.container.textContent).toContain(error);
  const retry = screen.container.querySelector<HTMLButtonElement>("button");
  expect(retry).not.toBeNull();
  act(() => retry!.click());
  expect(fetches.started).toBe(2);
});
