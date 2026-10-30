import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  session: null as {
    id: string;
    status: "active" | "pending" | "ended";
    user: { id: string };
    getToken: () => Promise<string | null>;
  } | null,
  sessions: [] as Array<{
    id: string;
    status: "active" | "pending" | "ended";
    user: { id: string };
    getToken: () => Promise<string | null>;
  }>,
  source: "window-origin",
  httpBaseUrl: "http://localhost:3773",
  hosted: false,
  localEnabled: true,
  linked: true,
  signOut: vi.fn(),
  unlink: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("@clerk/react"), async (original) => ({
  ...(await original()),
  useClerk: (() => ({ signOut: state.signOut })) as never,
  useSession: (() => ({ session: state.session })) as never,
  useSessionList: (() => ({ sessions: state.sessions })) as never,
}));
vi.mock(import("../../cloud/linkEnvironmentAtoms"), () => ({
  unlinkPrimaryEnvironment: {} as never,
}));
vi.mock(import("../../cloud/primaryCloudLinkState"), () => ({
  usePrimaryCloudLinkState: (() => ({
    target: {
      environmentId: EnvironmentId.make("local-host"),
      label: "Local host",
      httpBaseUrl: state.httpBaseUrl,
      wsBaseUrl: "ws://localhost:3773",
    },
    refresh: state.refresh,
  })) as never,
}));
vi.mock(import("../../cloud/publicConfig"), () => ({
  resolveRelayClerkTokenOptions: () => ({ template: "relay", skipCache: true }),
}));
vi.mock(import("../../environments/primary"), () => ({
  isLoopbackHostname: (hostname) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname),
  readPrimaryEnvironmentTarget: (() =>
    state.localEnabled
      ? { source: state.source, target: { httpBaseUrl: state.httpBaseUrl } }
      : null) as never,
}));
vi.mock(import("../../hostedPairing"), () => ({
  isHostedStaticApp: () => state.hosted,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => state.unlink) as never,
}));
vi.mock(import("../ui/toast"), () => ({
  toastManager: { add: state.toast } as never,
}));

import { useT3ConnectSignOut } from "./useT3ConnectSignOut";

function SignOutActions() {
  const actions = useT3ConnectSignOut();
  return (
    <>
      <button onClick={actions.signOut}>Sign out</button>
      {actions.hasOtherSessions ? <button onClick={actions.signOutAll}>Sign out all</button> : null}
    </>
  );
}

function setup() {
  vi.clearAllMocks();
  state.session = {
    id: "session-1",
    status: "active",
    user: { id: "account-1" },
    getToken: vi.fn(async () => "token-1"),
  };
  state.sessions = [state.session];
  state.source = "window-origin";
  state.httpBaseUrl = "http://localhost:3773";
  state.hosted = false;
  state.localEnabled = true;
  state.linked = true;
  state.unlink.mockImplementation(async () => {
    state.linked = false;
    return AsyncResult.success(undefined);
  });
  state.signOut.mockImplementation(async () => {
    state.session = null;
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("T3 Connect sign-out", () => {
  it("keeps the account signed in until its local host has been unlinked", async () => {
    setup();
    state.sessions.push({ ...state.session!, id: "ended-session", status: "ended" });
    const unlink = deferred();
    const started = deferred();
    state.unlink.mockImplementation(async () => {
      started.resolve();
      await unlink.promise;
      state.linked = false;
      return AsyncResult.success(undefined);
    });
    // These actions do not depend on routes; keeping the router out isolates the auth lifecycle.
    await using screen = await render(<SignOutActions />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Sign out", exact: true }));
    await started.promise;
    await expect
      .element(screen.getByRole("button", { name: "Sign out all" }))
      .not.toBeInTheDocument();

    expect(state.session?.id).toBe("session-1");
    expect(state.linked).toBe(true);
    expect(state.signOut).not.toHaveBeenCalled();

    await act(async () => unlink.resolve());
    await vi.waitFor(() => expect(state.session).toBeNull());
    expect(state.linked).toBe(false);
    expect(state.unlink).toHaveBeenCalledWith(
      expect.objectContaining({ expectedCloudUserId: "account-1", clerkToken: "token-1" }),
    );
  });

  it.each([
    ["hosted web", "https://app.t3.codes", true, true],
    ["LAN browser", "http://192.168.1.20:3773", false, true],
    ["Tailscale browser", "https://host.example.ts.net", false, true],
    ["remote-only desktop", "http://localhost:3773", false, false],
  ])(
    "signs out %s without unlinking another machine",
    async (_label, url, hosted, localEnabled) => {
      setup();
      state.httpBaseUrl = url;
      state.hosted = hosted;
      state.localEnabled = localEnabled;
      await using screen = await render(<SignOutActions />, { router: false });
      await userEvent.click(screen.getByRole("button", { name: "Sign out", exact: true }));

      await vi.waitFor(() => expect(state.session).toBeNull());
      expect(state.unlink).not.toHaveBeenCalled();
      expect(state.linked).toBe(true);
    },
  );

  it("unlinks a desktop-managed host even when WSL supplies a non-loopback origin", async () => {
    setup();
    state.source = "desktop-managed";
    state.httpBaseUrl = "http://172.20.0.2:3773";
    await using screen = await render(<SignOutActions />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Sign out", exact: true }));

    await vi.waitFor(() => expect(state.session).toBeNull());
    expect(state.linked).toBe(false);
  });

  it("still stops local exposure when the departing session cannot obtain a relay token", async () => {
    setup();
    state.session!.getToken = vi.fn(async () => {
      throw new Error("Session expired");
    });
    await using screen = await render(<SignOutActions />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Sign out", exact: true }));

    await vi.waitFor(() => expect(state.session).toBeNull());
    expect(state.linked).toBe(false);
    expect(state.unlink).toHaveBeenCalledWith(expect.objectContaining({ clerkToken: null }));
  });

  it("reports local unlink failure before ending the account session", async () => {
    setup();
    state.unlink.mockResolvedValue(AsyncResult.failure(Cause.die(new Error("Host unavailable"))));
    await using screen = await render(<SignOutActions />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Sign out", exact: true }));

    await vi.waitFor(() => expect(state.toast).toHaveBeenCalled());
    expect(state.session?.id).toBe("session-1");
    expect(state.linked).toBe(true);
  });

  it("checks every departing account when signing out all sessions", async () => {
    setup();
    state.sessions.push({
      id: "session-2",
      status: "pending",
      user: { id: "account-2" },
      getToken: async () => "token-2",
    });
    await using screen = await render(<SignOutActions />, { router: false });
    state.sessions.push({ ...state.session!, id: "ended-session", status: "ended" });
    await screen.rerender(<SignOutActions />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out all" }));

    await vi.waitFor(() => expect(state.session).toBeNull());
    expect(state.unlink.mock.calls.map(([input]) => input.expectedCloudUserId)).toEqual([
      "account-1",
      "account-2",
    ]);
    expect(state.signOut).toHaveBeenCalledWith(undefined, undefined);
  });

  it("does not unlink on account switching, signed-out startup, or unmount", async () => {
    setup();
    await using screen = await render(<SignOutActions />, { router: false });
    state.session = {
      id: "session-2",
      status: "active",
      user: { id: "account-2" },
      getToken: async () => "token-2",
    };
    await screen.rerender(<SignOutActions />);
    state.session = null;
    await screen.rerender(<SignOutActions />);
    await screen.unmount();

    expect(state.unlink).not.toHaveBeenCalled();
    expect(state.linked).toBe(true);
  });
});
