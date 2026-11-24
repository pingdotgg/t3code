import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

interface FakeSession {
  readonly id: string;
  readonly status: string;
}
interface FakeClient {
  readonly id: string;
  readonly lastActiveSessionId: string | null;
  readonly signedInSessions: readonly FakeSession[];
  readonly reload: () => Promise<FakeClient>;
}

const { Children, harness } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => <>{children}</>,
  harness: {
    clerk: null as unknown as {
      client: unknown;
      session: unknown;
      updateClient: (client: unknown) => void;
      setActive: ReturnType<typeof vi.fn>;
    },
    isSignedIn: false,
    authListeners: new Set<() => void>(),
  },
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock("@clerk/expo", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    harness.authListeners.add(listener);
    return () => harness.authListeners.delete(listener);
  };
  return {
    useAuth: () => ({
      isLoaded: true,
      isSignedIn: useSyncExternalStore(subscribe, () => harness.isSignedIn),
    }),
    getClerkInstance: () => harness.clerk,
  };
});
vi.mock("@clerk/expo/native-components", () => ({
  AuthView: () => <span>sign-in form</span>,
  UserProfileView: () => <span>profile</span>,
}));
vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => true }));
vi.mock("../cloud/T3ConnectProfilePage", () => ({ T3ConnectProfilePage: () => null }));

import { SettingsAuthRouteScreen } from "./SettingsAuthRouteScreen";

function client(sessions: readonly FakeSession[]): FakeClient {
  const self: FakeClient = {
    id: "client_device",
    lastActiveSessionId: sessions[0]?.id ?? null,
    signedInSessions: sessions,
    reload: async () => self,
  };
  return self;
}

function setup(...refreshes: readonly (FakeClient | Promise<FakeClient>)[]) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let calls = 0;
  const refresh = async () => refreshes[Math.min(calls++, refreshes.length - 1)]!;
  harness.isSignedIn = false;
  harness.authListeners.clear();
  harness.clerk = {
    client: { ...client([]), reload: refresh },
    session: null,
    updateClient: (next) => {
      harness.clerk.client = next;
    },
    setActive: vi.fn(async () => {
      harness.isSignedIn = true;
      for (const listener of harness.authListeners) listener();
    }),
  };
  return mount();
}

function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<SettingsAuthRouteScreen />));
  return { container, [Symbol.dispose]: () => act(() => root.unmount()) };
}

it("adopts the session the native-backed client already holds instead of offering a doomed sign-in", async () => {
  // The JS client is stale and signed out; refreshing it from the shared device
  // token returns the session native Clerk reports as `session_exists`.
  const { promise, resolve } = Promise.withResolvers<FakeClient>();
  using screen = setup(promise);

  await act(async () => resolve(client([{ id: "sess_native", status: "active" }])));
  expect(screen.container.textContent).toBe("profile");
  expect(harness.clerk.setActive).toHaveBeenCalledWith({
    session: expect.objectContaining({ id: "sess_native" }),
  });
});

it("a reopened screen waits for the refresh a dismissed screen left in flight", async () => {
  // The older reload mutates Clerk's shared client when it lands, so it must settle before sign-in.
  const { promise, resolve } = Promise.withResolvers<FakeClient>();
  const dismissed = setup(promise, client([]));
  dismissed[Symbol.dispose]();
  using reopened = mount();

  await act(async () => {});
  expect(reopened.container.textContent).not.toContain("sign-in form");

  await act(async () => resolve(client([])));
  expect(reopened.container.textContent).toContain("sign-in form");
});

it("offers the sign-in form when the client refresh stalls, and ignores its late result", async () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  const { promise, resolve } = Promise.withResolvers<FakeClient>();
  using screen = setup(promise);
  expect(screen.container.textContent).not.toContain("sign-in form");

  await act(async () => vi.advanceTimersByTime(8_000));
  expect(screen.container.textContent).toContain("sign-in form");

  await act(async () => resolve(client([{ id: "sess_late", status: "active" }])));
  expect(harness.clerk.setActive).not.toHaveBeenCalled();
});
