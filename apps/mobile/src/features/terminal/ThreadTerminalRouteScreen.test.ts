import { describe, expect, it } from "vitest";

import { resolveTerminalRouteBootstrap } from "./terminalRouteBootstrap";

describe("resolveTerminalRouteBootstrap", () => {
  it("redirects bare terminal routes to another already-running terminal for the thread", () => {
    expect(
      resolveTerminalRouteBootstrap({
        hasThread: true,
        hasWorkspaceRoot: true,
        hasOpened: false,
        requestedTerminalId: null,
        currentTerminalId: "default",
        runningTerminalId: "term-2",
        currentTerminalStatus: "closed",
        hasCurrentTerminalHydration: false,
      }),
    ).toEqual({
      kind: "redirect",
      terminalId: "term-2",
    });
  });

  it("hydrates the current running terminal when client state is not hydrated yet", () => {
    expect(
      resolveTerminalRouteBootstrap({
        hasThread: true,
        hasWorkspaceRoot: true,
        hasOpened: false,
        requestedTerminalId: null,
        currentTerminalId: "default",
        runningTerminalId: "default",
        currentTerminalStatus: "running",
        hasCurrentTerminalHydration: false,
      }),
    ).toEqual({
      kind: "open",
    });
  });

  it("opens explicit terminal routes when the session still needs hydration", () => {
    expect(
      resolveTerminalRouteBootstrap({
        hasThread: true,
        hasWorkspaceRoot: true,
        hasOpened: false,
        requestedTerminalId: "term-2",
        currentTerminalId: "term-2",
        runningTerminalId: "term-2",
        currentTerminalStatus: "running",
        hasCurrentTerminalHydration: false,
      }),
    ).toEqual({
      kind: "open",
    });
  });

  it("stays idle after the route already bootstrapped once", () => {
    expect(
      resolveTerminalRouteBootstrap({
        hasThread: true,
        hasWorkspaceRoot: true,
        hasOpened: true,
        requestedTerminalId: null,
        currentTerminalId: "default",
        runningTerminalId: "default",
        currentTerminalStatus: "running",
        hasCurrentTerminalHydration: true,
      }),
    ).toEqual({
      kind: "idle",
    });
  });

  it("stays idle when the current running terminal is already hydrated in client state", () => {
    expect(
      resolveTerminalRouteBootstrap({
        hasThread: true,
        hasWorkspaceRoot: true,
        hasOpened: false,
        requestedTerminalId: null,
        currentTerminalId: "default",
        runningTerminalId: "default",
        currentTerminalStatus: "running",
        hasCurrentTerminalHydration: true,
      }),
    ).toEqual({
      kind: "idle",
    });
  });

  it("stays idle for explicit running terminal routes that already have hydrated output", () => {
    expect(
      resolveTerminalRouteBootstrap({
        hasThread: true,
        hasWorkspaceRoot: true,
        hasOpened: false,
        requestedTerminalId: "term-2",
        currentTerminalId: "term-2",
        runningTerminalId: "term-2",
        currentTerminalStatus: "running",
        hasCurrentTerminalHydration: true,
      }),
    ).toEqual({
      kind: "idle",
    });
  });
});
