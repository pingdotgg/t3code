import type { Dispatch, ReactElement, SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY } from "../../cloud/connectOnboarding";

// Keep the pre-browser hook harness convention for this renderer-reload lifecycle:
// a reload discards hook slots while preserving the browser storage objects.
const hooks = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  let changed = false;
  return {
    reset() {
      slots = [];
      cursor = 0;
    },
    render<T>(render: () => T): T {
      for (let attempt = 0; attempt < 25; attempt++) {
        cursor = 0;
        changed = false;
        const result = render();
        if (!changed) return result;
      }
      throw new Error("Onboarding did not settle");
    },
    useState<T>(initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = cursor++;
      if (index >= slots.length) {
        slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      return [
        slots[index] as T,
        (next) => {
          const value =
            typeof next === "function" ? (next as (previous: T) => T)(slots[index] as T) : next;
          changed ||= !Object.is(slots[index], value);
          slots[index] = value;
        },
      ];
    },
    useMemoCache(size: number) {
      const index = cursor++;
      slots[index] ??= Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      return slots[index] as unknown[];
    },
  };
});

const state = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: false, userId: null as string | null },
  session: { _tag: "Success" as "Initial" | "Success" },
  openSignIn: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: hooks.useState,
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("@clerk/react", () => ({
  useAuth: () => state.auth,
  useClerk: () => ({ openSignIn: state.openSignIn }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.session }));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => true }));
vi.mock("../../cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => ({
    linkState: { data: null, error: null, target: null },
    operationError: null,
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ isReady: true, environments: [] }),
  usePrimaryEnvironmentId: () => "local",
  usePrimaryEnvironment: () => null,
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => "primary-session" },
  useEnvironmentScope: () => false,
  readEnvironmentScope: () => false,
}));
vi.mock("./CloudEnvironmentConnectList", () => ({ CloudEnvironmentConnectRows: () => null }));

import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { ConnectOnboardingDialog } from "./ConnectOnboardingDialog";

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function renderDialog() {
  const wrapper = ConnectOnboardingDialog() as ReactElement;
  const render = wrapper.type as () => ReactElement<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }>;
  return hooks.render(render).props;
}

function signIn(userId = "account-a") {
  state.auth = { isLoaded: true, isSignedIn: true, userId };
}

function signOut() {
  state.auth = { isLoaded: true, isSignedIn: false, userId: null };
}

describe("ConnectOnboardingDialog auth lifecycle", () => {
  beforeEach(() => {
    hooks.reset();
    signOut();
    state.session = { _tag: "Success" };
    state.openSignIn.mockReset();
    vi.stubGlobal("window", {
      location: { href: "t3code-dev://app/#/settings/connections" },
      sessionStorage: createStorage(),
      localStorage: createStorage(),
      dispatchEvent: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([true, false])(
    "opens once after sign-in reload (auth initially loaded: %s)",
    (initiallyLoaded) => {
      expect(renderDialog().open).toBe(false);
      // Clerk can reload synchronously: the pending marker must already exist.
      state.openSignIn.mockImplementationOnce(() => {
        hooks.reset();
        state.auth = {
          isLoaded: initiallyLoaded,
          isSignedIn: true,
          userId: initiallyLoaded ? "account-a" : null,
        };
        state.session = { _tag: "Initial" };
        expect(renderDialog().open).toBe(false);
        signIn();
        expect(renderDialog().open).toBe(false);
        state.session = { _tag: "Success" };
        expect(renderDialog().open).toBe(true);
      });

      hooks.render(useT3ConnectAuthPrompt).openAuthPrompt();
      expect(state.openSignIn).toHaveBeenCalledOnce();
      expect(renderDialog().open).toBe(true);
      renderDialog().onOpenChange(false);
      expect(renderDialog().open).toBe(false);
      hooks.reset();
      expect(renderDialog().open).toBe(false);
    },
  );

  it("does not open another onboarding dialog after welcome handles sign-in", () => {
    hooks.render(() => useT3ConnectAuthPrompt({ requestOnboarding: false })).openAuthPrompt();
    expect(state.openSignIn).toHaveBeenCalledOnce();
    hooks.reset();
    signIn();
    expect(renderDialog().open).toBe(false);
  });

  it("keeps a restored session closed through incomplete auth snapshots", () => {
    state.auth = { isLoaded: false, isSignedIn: true, userId: null };
    expect(renderDialog().open).toBe(false);
    state.auth.isLoaded = true;
    expect(renderDialog().open).toBe(false);
    signIn();
    expect(renderDialog().open).toBe(false);
    hooks.reset();
    expect(renderDialog().open).toBe(false);
  });

  it("honors persisted opt-outs after reload and still opens for another account", () => {
    window.localStorage.setItem(
      CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
      JSON.stringify({ optOutAccounts: ["account-a"] }),
    );
    hooks.render(useT3ConnectAuthPrompt).openAuthPrompt();
    hooks.reset();
    signIn();
    expect(renderDialog().open).toBe(false);
    signIn("account-b");
    expect(renderDialog().open).toBe(true);
    signOut();
    expect(renderDialog().open).toBe(false);
    signIn();
    expect(renderDialog().open).toBe(false);
    signIn("account-b");
    expect(renderDialog().open).toBe(true);
  });

  it("allows sign-in and in-session onboarding when session storage is unavailable", () => {
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });
    expect(renderDialog().open).toBe(false);
    state.openSignIn.mockImplementationOnce(() => signIn());
    hooks.render(useT3ConnectAuthPrompt).openAuthPrompt();
    expect(state.openSignIn).toHaveBeenCalledOnce();
    expect(renderDialog().open).toBe(true);
    renderDialog().onOpenChange(false);
    expect(renderDialog().open).toBe(false);
    hooks.reset();
    expect(renderDialog().open).toBe(false);
  });
});
