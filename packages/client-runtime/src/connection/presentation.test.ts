import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  RelayConnectionTarget,
  type SupervisorConnectionState,
} from "./model.ts";
import { environmentMcpUrl, pairAgainAddress, presentConnectionState } from "./presentation.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});

const ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
  ),
  enabled: true,
};

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("copies the MCP address of the route this device is connected over", () => {
    const route = (connectionId: string, httpBaseUrl: string): ConnectionRoute => {
      const target = new BearerConnectionTarget({ ...TARGET, connectionId });
      return {
        target,
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId,
            environmentId: TARGET.environmentId,
            label: TARGET.label,
            httpBaseUrl,
            wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
          }),
        ),
      };
    };
    const lan = route("lan", "http://192.168.4.53:3773/");
    const tailnet = route("tailnet", "http://100.115.1.44:3773/");
    const serve = route("serve", "https://machine.tailnet.ts.net/");
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: lan.target,
      profile: lan.profile,
      alternateRoutes: [tailnet, serve],
    };

    expect(environmentMcpUrl({ entry, connectedTarget: tailnet.target })).toBe(
      "http://100.115.1.44:3773/mcp",
    );
    expect(environmentMcpUrl({ entry })).toBe("http://192.168.4.53:3773/mcp");
  });

  // regression: #16909 Copy MCP URL falls back to an alternate route when the relay route has no address
  it("passes over routes without an address of their own", () => {
    const relay = new RelayConnectionTarget({
      environmentId: TARGET.environmentId,
      label: TARGET.label,
    });
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: relay,
      profile: Option.none(),
      alternateRoutes: [{ target: ENTRY.target, profile: ENTRY.profile }],
    };

    expect(environmentMcpUrl({ entry, connectedTarget: relay })).toBe(
      "https://environment.example.test/mcp",
    );
    expect(
      environmentMcpUrl({
        entry,
        connectedTarget: relay,
        relayHttpBaseUrl: "https://tunnel.example.test",
      }),
    ).toBe("https://tunnel.example.test/mcp");
  });

  it("distinguishes initial connection, reconnect, and retry errors", () => {
    expect(presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 }))).toEqual({
      phase: "connecting",
      error: null,
      traceId: null,
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Socket closed.",
            traceId: "trace-previous",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Socket closed.",
      traceId: "trace-previous",
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "backoff",
          attempt: 2,
          retryAt: 1,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
            traceId: "trace-1",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Disconnected.",
      traceId: "trace-1",
    });
  });

  it("preserves an explicitly available environment while offline", () => {
    expect(
      presentConnectionState(
        supervisorState({
          desired: false,
          network: "offline",
          phase: "available",
          stage: null,
          attempt: 0,
        }),
      ),
    ).toEqual({
      phase: "available",
      error: null,
      traceId: null,
    });
  });

  it("offers pairing again only when the paired address's credential is refused", () => {
    const blocked = (
      reason: "authentication" | "configuration",
      failure: Partial<Pick<ConnectionBlockedError, "hop" | "via">> = {
        hop: "server",
        via: "direct",
      },
    ) =>
      presentConnectionState(
        supervisorState({
          phase: "blocked",
          lastFailure: new ConnectionBlockedError({ reason, detail: "Refused.", ...failure }),
        }),
      );
    const relay = new RelayConnectionTarget({
      environmentId: TARGET.environmentId,
      label: TARGET.label,
    });
    const relayOnly: ConnectionCatalogEntry = { ...ENTRY, target: relay, profile: Option.none() };

    expect(pairAgainAddress({ entry: ENTRY, connection: blocked("authentication") })).toBe(
      "https://environment.example.test",
    );
    expect(pairAgainAddress({ entry: ENTRY, connection: blocked("configuration") })).toBeNull();
    // T3 Connect signs in through the account, so a new pairing code would not help.
    expect(
      pairAgainAddress({ entry: relayOnly, connection: blocked("authentication") }),
    ).toBeNull();
    // With a T3 Connect route as well, a refused sign-in says nothing about the paired address.
    const mixed: ConnectionCatalogEntry = {
      ...ENTRY,
      alternateRoutes: [{ target: relay, profile: Option.none() }],
    };
    expect(
      pairAgainAddress({
        entry: mixed,
        connection: blocked("authentication", { hop: "server", via: "relay" }),
      }),
    ).toBeNull();
    expect(pairAgainAddress({ entry: mixed, connection: blocked("authentication") })).toBe(
      "https://environment.example.test",
    );

    // A learned route borrows the paired route's credential, so pairing it would
    // mint nothing; the paired address is the one to pair again.
    const learnedConnectionId = `learned:tailnet@${TARGET.connectionId}`;
    const learned: ConnectionRoute = {
      target: new BearerConnectionTarget({ ...TARGET, connectionId: learnedConnectionId }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: learnedConnectionId,
          environmentId: TARGET.environmentId,
          label: TARGET.label,
          httpBaseUrl: "https://machine.tailnet.example.test",
          wsBaseUrl: "wss://machine.tailnet.example.test",
          learned: true,
        }),
      ),
    };
    const learnedFirst: ConnectionCatalogEntry = {
      ...ENTRY,
      ...learned,
      alternateRoutes: [{ target: ENTRY.target, profile: ENTRY.profile }],
    };
    expect(pairAgainAddress({ entry: learnedFirst, connection: blocked("authentication") })).toBe(
      "https://environment.example.test",
    );
    const learnedOnly: ConnectionCatalogEntry = { ...ENTRY, ...learned };
    expect(
      pairAgainAddress({ entry: learnedOnly, connection: blocked("authentication") }),
    ).toBeNull();
  });
});
