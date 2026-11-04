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
  readonly fetch: () => Promise<FakeClient>;
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
  },
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
  useClerk: () => harness.clerk,
  getClerkInstance: () => harness.clerk,
}));
vi.mock("@clerk/expo/native-components", () => ({
  AuthView: () => <span>sign-in form</span>,
  UserProfileView: () => null,
}));
vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => true }));
vi.mock("../cloud/T3ConnectProfilePage", () => ({ T3ConnectProfilePage: () => null }));

import { SettingsAuthRouteScreen } from "./SettingsAuthRouteScreen";

function client(sessions: readonly FakeSession[]): FakeClient {
  const self: FakeClient = {
    id: "client_device",
    lastActiveSessionId: sessions[0]?.id ?? null,
    signedInSessions: sessions,
    fetch: async () => self,
    reload: async () => self,
  };
  return self;
}

function setup(refreshed: FakeClient | Promise<FakeClient>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const refresh = async () => refreshed;
  const stale = { ...client([]), fetch: refresh, reload: refresh };
  harness.clerk = {
    client: stale,
    session: null,
    updateClient: (next) => {
      harness.clerk.client = next;
    },
    setActive: vi.fn(async () => {}),
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<SettingsAuthRouteScreen />));
  return { container, [Symbol.dispose]: () => act(() => root.unmount()) };
}

it("adopts the session the native-backed client already holds instead of offering a doomed sign-in", async () => {
  const nativeSession = { id: "sess_native", status: "active" };
  // The JS client is stale and signed out; refreshing it from the shared device
  // token returns the session native Clerk reports as `session_exists`.
  using _screen = setup(client([nativeSession]));

  await vi.waitFor(() => {
    const activated = harness.clerk.setActive.mock.calls.map(([params]) => {
      const session = (params as { session?: unknown } | undefined)?.session;
      return typeof session === "string" ? session : (session as FakeSession | null)?.id;
    });
    expect(activated, "the native session was never activated in JS").toContain("sess_native");
  });
});

it("leaves a truly signed-out user on the sign-in form", async () => {
  const refreshed = client([]);
  using screen = setup(refreshed);

  await vi.waitFor(() => expect(screen.container.textContent).toContain("sign-in form"));
  expect(harness.clerk.client).toBe(refreshed);
  expect(harness.clerk.setActive).not.toHaveBeenCalled();
});

it("does not offer the sign-in form until the client refresh settles", async () => {
  // A native sign-in during a slow refresh would be wiped when the stale response lands.
  const { promise, resolve } = Promise.withResolvers<FakeClient>();
  using screen = setup(promise);

  expect(screen.container.textContent).not.toContain("sign-in form");

  await act(async () => resolve(client([])));
  expect(screen.container.textContent).toContain("sign-in form");
  expect(harness.clerk.setActive).not.toHaveBeenCalled();
});
