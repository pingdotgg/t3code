import { describe, expect, it } from "vite-plus/test";

import {
  CLERK_UNAVAILABLE_HINT,
  resolveT3ConnectClerkAvailability,
  resolveT3ConnectSidebarPresentation,
  resolveT3ConnectSidebarView,
} from "./T3ConnectSidebarControl.logic";

describe("resolveT3ConnectSidebarPresentation", () => {
  it.each([
    {
      expected: { label: "Connected", tone: "success" },
      input: {
        error: null,
        isPending: false,
        managedTunnelActive: true,
        publishAgentActivity: false,
      },
    },
    {
      expected: { label: "Activity only", tone: "success" },
      input: {
        error: null,
        isPending: false,
        managedTunnelActive: false,
        publishAgentActivity: true,
      },
    },
    {
      expected: { label: "Not linked", tone: "muted" },
      input: {
        error: null,
        isPending: false,
        managedTunnelActive: false,
        publishAgentActivity: false,
      },
    },
    {
      expected: { label: "Connecting…", tone: "pending" },
      input: {
        error: null,
        isPending: true,
        managedTunnelActive: false,
        publishAgentActivity: false,
      },
    },
    {
      expected: { label: "Connection error", tone: "error" },
      input: {
        error: "Relay unavailable",
        isPending: false,
        managedTunnelActive: true,
        publishAgentActivity: true,
      },
    },
  ])("resolves $expected.label", ({ expected, input }) => {
    expect(resolveT3ConnectSidebarPresentation(input)).toEqual(expected);
  });
});

describe("resolveT3ConnectClerkAvailability", () => {
  it.each([
    { expected: "signed-in", isLoaded: true, isSignedIn: true, loadTimedOut: false },
    { expected: "signed-out", isLoaded: true, isSignedIn: false, loadTimedOut: false },
    // Timeout is irrelevant once Clerk is loaded.
    { expected: "signed-out", isLoaded: true, isSignedIn: undefined, loadTimedOut: true },
    { expected: "loading", isLoaded: false, isSignedIn: undefined, loadTimedOut: false },
    { expected: "unavailable", isLoaded: false, isSignedIn: undefined, loadTimedOut: true },
  ])(
    "resolves $expected (isLoaded=$isLoaded, timedOut=$loadTimedOut)",
    ({ expected, isLoaded, isSignedIn, loadTimedOut }) => {
      expect(resolveT3ConnectClerkAvailability({ isLoaded, isSignedIn, loadTimedOut })).toBe(
        expected,
      );
    },
  );
});

describe("resolveT3ConnectSidebarView", () => {
  const settledLocal = {
    error: null,
    hasLinkState: true,
    isPending: false,
  } as const;

  it("shows Connected for a CLI-linked machine even when signed out", () => {
    expect(
      resolveT3ConnectSidebarView({
        ...settledLocal,
        clerk: "signed-out",
        managedTunnelActive: true,
        publishAgentActivity: false,
      }),
    ).toEqual({
      hint: null,
      kind: "status",
      presentation: { label: "Connected", tone: "success" },
      showSignInAction: true,
    });
  });

  it("shows Activity only for a publish-only link when signed out", () => {
    expect(
      resolveT3ConnectSidebarView({
        ...settledLocal,
        clerk: "signed-out",
        managedTunnelActive: false,
        publishAgentActivity: true,
      }),
    ).toEqual({
      hint: null,
      kind: "status",
      presentation: { label: "Activity only", tone: "success" },
      showSignInAction: true,
    });
  });

  it("keeps the sign-in row for a settled, fully unlinked machine when signed out", () => {
    const view = resolveT3ConnectSidebarView({
      ...settledLocal,
      clerk: "signed-out",
      managedTunnelActive: false,
      publishAgentActivity: false,
    });
    expect(view.kind).toBe("sign-in");
    expect(view.showSignInAction).toBe(false);
  });

  it("surfaces local read failures when signed out with a sign-in action", () => {
    expect(
      resolveT3ConnectSidebarView({
        clerk: "signed-out",
        error: "Relay unavailable",
        hasLinkState: false,
        isPending: false,
        managedTunnelActive: false,
        publishAgentActivity: false,
      }),
    ).toEqual({
      hint: null,
      kind: "status",
      presentation: { label: "Connection error", tone: "error" },
      showSignInAction: true,
    });
  });

  it("falls back to local state with a hint when Clerk load times out", () => {
    expect(
      resolveT3ConnectSidebarView({
        ...settledLocal,
        clerk: "unavailable",
        managedTunnelActive: true,
        publishAgentActivity: false,
      }),
    ).toEqual({
      hint: CLERK_UNAVAILABLE_HINT,
      kind: "status",
      presentation: { label: "Connected", tone: "success" },
      showSignInAction: false,
    });
  });

  it("shows Not linked (not the sign-in row) when Clerk is unavailable", () => {
    const view = resolveT3ConnectSidebarView({
      ...settledLocal,
      clerk: "unavailable",
      managedTunnelActive: false,
      publishAgentActivity: false,
    });
    expect(view).toEqual({
      hint: CLERK_UNAVAILABLE_HINT,
      kind: "status",
      presentation: { label: "Not linked", tone: "muted" },
      showSignInAction: false,
    });
  });

  it("shows Connecting… only while Clerk loads and the local read has produced nothing", () => {
    expect(
      resolveT3ConnectSidebarView({
        clerk: "loading",
        error: null,
        hasLinkState: false,
        isPending: true,
        managedTunnelActive: false,
        publishAgentActivity: false,
      }),
    ).toEqual({
      hint: null,
      kind: "status",
      presentation: { label: "Connecting…", tone: "pending" },
      showSignInAction: false,
    });
  });

  it("prefers resolved local state over Connecting… while Clerk loads", () => {
    expect(
      resolveT3ConnectSidebarView({
        ...settledLocal,
        clerk: "loading",
        managedTunnelActive: true,
        publishAgentActivity: false,
      }),
    ).toEqual({
      hint: null,
      kind: "status",
      presentation: { label: "Connected", tone: "success" },
      showSignInAction: false,
    });
  });

  it("keeps the signed-in presentation unchanged (status, no action, no hint)", () => {
    expect(
      resolveT3ConnectSidebarView({
        ...settledLocal,
        clerk: "signed-in",
        managedTunnelActive: false,
        publishAgentActivity: false,
      }),
    ).toEqual({
      hint: null,
      kind: "status",
      presentation: { label: "Not linked", tone: "muted" },
      showSignInAction: false,
    });
  });
});
