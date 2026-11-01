import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { acquireRelayClientForLink, formatCloudStatus } from "./connect.ts";

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

it.effect("does not install the relay client when the user declines the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: () =>
          Effect.sync(() => {
            installCalls += 1;
            return managedExecutable;
          }),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(false),
      () => Effect.void,
    );

    assert.isTrue(Option.isNone(result));
    assert.equal(installCalls, 0);
  }),
);

const linkedStatus = {
  desired: true,
  authenticated: true,
  linked: true,
  revoked: false,
  cloudUserId: "user",
  relayUrl: "https://relay.example.test",
  publishAgentActivity: true,
  relayClient: managedExecutable,
  linkMode: "managed",
  reachability: {
    status: "reachable",
    checkedAt: "2026-10-26T00:00:00.000Z",
    readyConnections: 4,
    protocol: "quic",
    hostname: "tunnel.example.test",
  },
} as const;

it("prints the checked tunnel's MCP URL in connect status", () => {
  const output = formatCloudStatus(linkedStatus);
  assert.include(output, "Other devices can reach this machine");
  assert.include(output, "MCP URL for outside agents: https://tunnel.example.test/mcp");
  assert.deepEqual(JSON.parse(formatCloudStatus(linkedStatus, { json: true })), linkedStatus);
});

it("omits MCP URLs when no tunnel hostname was checked", () => {
  const { hostname: _hostname, ...reachability } = linkedStatus.reachability;
  assert.notInclude(formatCloudStatus({ ...linkedStatus, reachability }), "MCP URL");
  assert.notInclude(formatCloudStatus({ ...linkedStatus, reachability: null }), "MCP URL");
  assert.notInclude(formatCloudStatus({ ...linkedStatus, desired: false }), "MCP URL");
  assert.notInclude(formatCloudStatus({ ...linkedStatus, revoked: true }), "MCP URL");
  assert.notInclude(formatCloudStatus({ ...linkedStatus, linkMode: "publish_only" }), "MCP URL");
});
