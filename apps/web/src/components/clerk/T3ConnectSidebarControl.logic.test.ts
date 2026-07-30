import { describe, expect, it } from "vite-plus/test";

import { resolveT3ConnectSidebarPresentation } from "./T3ConnectSidebarControl.logic";

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
