import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cloudChangeReplacesLink } from "./t3ConnectState";

function linkState(input: {
  readonly linked: boolean;
  readonly tunnel: boolean;
  readonly revoked?: boolean;
}): EnvironmentCloudLinkStateResult {
  return {
    linked: input.linked,
    cloudUserId: input.linked ? "user" : null,
    relayUrl: input.linked ? "https://relay.example.test" : null,
    relayIssuer: null,
    managedTunnelActive: input.tunnel,
    publishAgentActivity: input.linked,
    linkRevoked: input.revoked ?? false,
  };
}

describe("cloudChangeReplacesLink", () => {
  it.each([
    {
      name: "linking a tunnel",
      state: { linked: false, tunnel: false },
      tunnel: true,
      publish: false,
      expected: true,
    },
    {
      name: "linking publish-only",
      state: { linked: false, tunnel: false },
      tunnel: false,
      publish: true,
      expected: true,
    },
    {
      name: "repairing a revoked link",
      state: { linked: true, tunnel: true, revoked: true },
      tunnel: true,
      publish: true,
      expected: true,
    },
    {
      name: "dropping the tunnel but keeping publish",
      state: { linked: true, tunnel: true },
      tunnel: false,
      publish: true,
      expected: true,
    },
    {
      name: "adding a tunnel to a publish-only link",
      state: { linked: true, tunnel: false },
      tunnel: true,
      publish: true,
      expected: true,
    },
    {
      name: "unlinking",
      state: { linked: true, tunnel: true },
      tunnel: false,
      publish: false,
      expected: false,
    },
    {
      name: "toggling publish on a tunnel link",
      state: { linked: true, tunnel: true },
      tunnel: true,
      publish: false,
      expected: false,
    },
  ])("$name → $expected", ({ state, tunnel, publish, expected }) => {
    expect(
      cloudChangeReplacesLink(linkState(state), undefined, { managedTunnel: tunnel, publish }),
    ).toBe(expected);
  });
});
