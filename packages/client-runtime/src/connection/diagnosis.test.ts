import type { DesktopTailscalePeer, ServerTailscaleStatus } from "@t3tools/contracts";
import {
  RelayEnvironmentEndpointUnavailableError,
  type RelayProtectedError,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  type ConnectionDiagnosisInput,
  connectionDiagnosisText,
  hostTailscaleNotice,
  offTailnetHint,
  presentConnectionDiagnosis,
} from "./diagnosis.ts";
import { mapManagedRelayError, mapRemoteEnvironmentError } from "./errors.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionAttemptError,
  type ConnectionRouteOutcome,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "./model.ts";
import { tailnetRefusalError } from "./tailnet.ts";
import { ManagedRelayRequestFailedError } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";

const backoff = (lastFailure: ConnectionAttemptError): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "backoff",
  attempt: 3,
  lastFailure,
  retryAt: Date.UTC(2026, 9, 19, 12, 0, 30),
});

const fromRelay = (relayError: RelayProtectedError) =>
  mapManagedRelayError(
    new ManagedRelayRequestFailedError({
      action: "connect relay environment",
      cause: relayError,
      relayError,
    }),
  );

const unavailable = (endpointFailure: "tunnel_down" | "origin_unreachable") =>
  fromRelay(
    new RelayEnvironmentEndpointUnavailableError({
      code: "environment_endpoint_unavailable",
      reason: "endpoint_request_failed",
      endpointFailure,
      endpointStatus: endpointFailure === "tunnel_down" ? 530 : 502,
      traceId: "trace-1",
    }),
  );

const tailnetTimeout = new ConnectionTransientError({
  reason: "timeout",
  detail: "Mac mini did not respond during connection setup.",
});
const TAILNET_FAILED: ConnectionRouteOutcome = {
  routeId: "bearer:tailnet",
  kind: "tailnet",
  address: "http://100.64.0.1:3773/",
  result: "failed",
  error: tailnetTimeout,
};
const RELAY_ANSWERED: ConnectionRouteOutcome = {
  routeId: "relay",
  kind: "relay",
  address: null,
  result: "answered",
};

const diagnose = (state: SupervisorConnectionState, via: "relay" | "direct" = "relay") =>
  presentConnectionDiagnosis({ hostLabel: "Mac mini", state, via });

const results = (state: SupervisorConnectionState, via?: "relay" | "direct") =>
  diagnose(state, via)?.hops.map((hop) => `${hop.hop}:${hop.result}`);

describe("presentConnectionDiagnosis", () => {
  it("tells a working tunnel apart from T3 Code not answering", () => {
    expect(diagnose(backoff(unavailable("origin_unreachable")))?.headline).toBe(
      "Tunnel works, but T3 Code on Mac mini did not answer",
    );
    expect(results(backoff(unavailable("origin_unreachable")), "direct")).toEqual([
      "device:ok",
      "relay:ok",
      "tunnel:ok",
      "server:failed",
    ]);
  });

  it("blames this device when it cannot reach a tunnel the relay already reached", () => {
    const failure = mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
      "relay",
    );
    // A learned LAN route makes the environment's usual route direct; the failure still names the relay.
    const diagnosis = diagnose(backoff(failure), "direct");
    expect(diagnosis?.headline).toBe("This device can't reach Mac mini's tunnel");
    expect(diagnosis?.hops).toHaveLength(4);
    expect(diagnosis?.steps.join(" ")).not.toContain("On Mac mini");
  });

  it("stops at T3 Connect when this device cannot reach the relay", () => {
    const failure = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        transportFailed: true,
        cause: new TypeError("Failed to fetch"),
      }),
    );
    expect(diagnose(backoff(failure))?.headline).toBe("This device can't reach T3 Connect");
    expect(results(backoff(failure))).toEqual([
      "device:ok",
      "relay:failed",
      "tunnel:unchecked",
      "server:unchecked",
    ]);
  });

  it("does not blame this device's network when T3 Connect answered with an error", () => {
    const failure = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        cause: new Error("Bad Gateway"),
        status: 502,
      }),
    );
    const diagnosis = diagnose(backoff(failure));
    expect(diagnosis?.headline).toBe("T3 Connect returned an error");
    expect(diagnosis?.steps.join(" ")).not.toContain("this device");
  });

  it("reports this device as offline before any other hop", () => {
    const state = { ...backoff(unavailable("tunnel_down")), network: "offline" as const };
    expect(diagnose(state)?.headline).toBe("This device is offline");
    expect(results(state)?.[0]).toBe("device:failed");
  });

  it("uses the relay health check before any connect attempt fails", () => {
    const diagnosis = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: AVAILABLE_CONNECTION_STATE,
      via: "relay",
      relayStatus: { status: "offline", endpointFailure: "tunnel_down", endpointStatus: 530 },
    });
    expect(diagnosis?.headline).toBe("Mac mini's tunnel is offline");
    const origin = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: AVAILABLE_CONNECTION_STATE,
      via: "relay",
      relayStatus: { status: "offline", endpointFailure: "origin_unreachable" },
    });
    expect(origin?.hops.map((hop) => hop.hop)).toEqual(["device", "relay", "tunnel", "server"]);
    // Another route may still work, so the relay's health alone is no failure.
    const withDirectRoute = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: AVAILABLE_CONNECTION_STATE,
      via: "direct",
      relayStatus: { status: "offline", endpointFailure: "origin_unreachable" },
    });
    expect(withDirectRoute).toBeNull();
  });

  it("names a Tailscale route that did not answer and keeps the relay status", () => {
    const state = { ...backoff(tailnetTimeout), routes: [TAILNET_FAILED] };
    const plain = diagnose(state, "direct");
    expect(plain?.headline).toBe("Mac mini did not answer over Tailscale");
    expect(plain?.steps[0]).toBe(
      "Check that Tailscale is on and signed in on this device and on Mac mini.",
    );
    expect(plain?.facts).toContainEqual(["Failed route", "Tailscale http://100.64.0.1:3773/"]);
    // Another route reached the host and it failed there, so Tailscale is not the story.
    const hostFailed = diagnose(
      {
        ...backoff(new ConnectionTransientError({ reason: "remote-unavailable", detail: "500" })),
        routes: [TAILNET_FAILED],
      },
      "direct",
    );
    expect(hostFailed?.headline).not.toMatch(/Tailscale/);
    expect(hostFailed?.facts.map(([label]) => label)).not.toContain("Failed route");
    expect(plain?.moreInfoUrl).toMatch(/remote-access\.md#tailscale-troubleshooting$/);

    const relayOnline = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state,
      via: "direct",
      relayStatus: { status: "online" },
    });
    expect(relayOnline?.headline).toBe(
      "Mac mini is online on T3 Connect, but its Tailscale address did not answer",
    );
    expect(relayOnline?.facts).toContainEqual(["T3 Connect", "online"]);

    const tailscaleOff = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state,
      via: "direct",
      localTailscale: { state: "stopped", peers: [] },
    });
    expect(tailscaleOff?.headline).toBe("Tailscale is off on this device");
    expect(tailscaleOff?.hops.map((hop) => `${hop.hop}:${hop.result}`)).toEqual([
      "device:failed",
      "server:unchecked",
    ]);

    // A Tailscale route that answered leaves the generic diagnosis.
    const answered = { ...TAILNET_FAILED, result: "answered" } as const;
    expect(diagnose({ ...state, routes: [answered] }, "direct")?.headline).toBe(
      "T3 Code on Mac mini did not answer",
    );
  });

  it("names the check a host's Tailscale sign-in refused instead of guessing", () => {
    const refused = (reason: "blocked" | "rate_limited") => {
      const error = tailnetRefusalError(reason);
      return diagnose({ ...backoff(error), routes: [{ ...TAILNET_FAILED, error }] }, "direct");
    };
    expect(refused("blocked")).toMatchObject({
      headline: "Mac mini blocked this device",
      steps: [
        "On another device connected to Mac mini, open Settings > Environments and unblock this device.",
        "Or run `t3 pair` on Mac mini, pair this device with the code, then unblock it.",
      ],
      moreInfoUrl: expect.stringMatching(/#tailscale-troubleshooting$/),
    });
    expect(refused("blocked")?.facts).toContainEqual(["Cause", "blocked"]);
    // Add forms show the error itself, so it reads as a sentence.
    expect(tailnetRefusalError("routes_for_others").message).toBe(
      "This device is a subnet router, so it cannot sign in. Traffic it forwards could arrive as this device, so no grant lets it in. Stop advertising routes on it. Or pair this device with a code instead.",
    );
    // A transient refusal answered, so it is not an unreachable tailnet.
    expect(refused("rate_limited")?.headline).toBe("Mac mini asked this device to slow down");
    // A host that cannot read its policy yet is retried, not given up on.
    expect(tailnetRefusalError("policy_unknown")._tag).toBe("ConnectionTransientError");
    // The host's suggested grant is there to paste, and in the copied report.
    const snippet = '"grants": [{ "src": ["you@example.com"] }]';
    const noGrant = diagnose(
      backoff(tailnetRefusalError("no_grant", undefined, snippet)),
      "direct",
    );
    expect(noGrant?.policySnippet).toBe(snippet);
    expect(connectionDiagnosisText("Mac mini", noGrant!)).toContain(snippet);
    const offline = { ...backoff(tailnetRefusalError("blocked")), network: "offline" as const };
    expect(diagnose(offline, "direct")?.headline).toBe("This device is offline");
  });
});

describe("Tailscale facts in the diagnosis", () => {
  const NOW = Date.UTC(2026, 9, 28, 12);
  const HOUR = 60 * 60 * 1000;
  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const state = { ...backoff(tailnetTimeout), routes: [TAILNET_FAILED] };
  const peer: DesktopTailscalePeer = {
    tailnetAddresses: ["100.64.0.1"],
    magicDnsName: "mac-mini.tail1234.ts.net",
    online: true,
    lastSeen: null,
    active: true,
    curAddr: null,
    relay: "fra",
    peerRelay: null,
  };
  const withFacts = (facts: Partial<ConnectionDiagnosisInput>) =>
    presentConnectionDiagnosis({ hostLabel: "Mac mini", state, via: "direct", now: NOW, ...facts });
  const fact = (diagnosis: ReturnType<typeof withFacts>, label: string) =>
    diagnosis?.facts.find(([name]) => name === label)?.[1];

  it("blames this device first, then what the host last reported, then the peer list", () => {
    const signedOutHost: ServerTailscaleStatus = {
      state: "needs_login",
      checkedAt: iso(NOW - 2 * HOUR),
      magicDnsName: null,
      keyExpiry: null,
      issues: [{ cause: "needs_login", fix: "Run `sudo tailscale up` and log in." }],
    };
    const host = withFacts({ hostTailscale: signedOutHost });
    expect(host?.headline).toBe("Tailscale on Mac mini is signed out (as of 2h ago)");
    expect(host?.steps).toEqual(["On Mac mini: Run `sudo tailscale up` and log in."]);

    const localDown = withFacts({
      hostTailscale: signedOutHost,
      localTailscale: { state: "needs_login", peers: [] },
    });
    expect(localDown?.headline).toBe("Tailscale on this device is signed out");
    const awaitingApproval = withFacts({
      localTailscale: { state: "needs_machine_approval", peers: [] },
    });
    expect(awaitingApproval?.steps[0]).toMatch(
      /^Approve this device at https:\/\/login\.tailscale/,
    );

    const running = (peers: ReadonlyArray<DesktopTailscalePeer>) =>
      withFacts({ localTailscale: { state: "running", peers } });
    const lastSeen = iso(NOW - 2 * HOUR);
    expect(running([{ ...peer, online: false, lastSeen }])?.headline).toBe(
      "Mac mini is offline on your tailnet (last seen 2h ago)",
    );
    expect(running([])?.headline).toBe("Mac mini is not on this device's tailnet");
    // Online is only a hint, so the headline stays the generic one.
    expect(running([peer])?.headline).toBe("Mac mini did not answer over Tailscale");
    // A direct path needs a handshake, so Tailscale reached the host.
    expect(running([{ ...peer, curAddr: "203.0.113.4:41641" }])?.headline).toBe(
      "T3 Code on Mac mini did not answer",
    );
  });

  it("names the path to a peer only while it is active", () => {
    const peerFact = (candidate: DesktopTailscalePeer) =>
      fact(
        withFacts({ localTailscale: { state: "running", peers: [candidate] } }),
        "Tailscale peer",
      );
    expect(peerFact(peer)).toBe("online, DERP (fra)");
    expect(peerFact({ ...peer, curAddr: "203.0.113.4:41641" })).toBe("online, direct");
    expect(peerFact({ ...peer, peerRelay: "100.64.0.9:40000" })).toBe("online, peer relay");
    expect(peerFact({ ...peer, active: false, curAddr: "203.0.113.4:41641" })).toBe("online");
  });

  it("shows only host issues that matter to someone connecting", () => {
    const status = (issues: ServerTailscaleStatus["issues"]): ServerTailscaleStatus => ({
      state: "running",
      checkedAt: iso(NOW),
      magicDnsName: null,
      keyExpiry: iso(NOW + 3 * 24 * HOUR),
      issues,
    });
    const https = { cause: "https_off", fix: "Turn on HTTPS." } as const;
    const expiring = { cause: "key_expiring", fix: "Log in again." } as const;
    expect(hostTailscaleNotice("Mac mini", status([https]), NOW)).toBeNull();
    expect(hostTailscaleNotice("Mac mini", status([https, expiring]), NOW)?.headline).toBe(
      "The Tailscale node key on Mac mini expires in 3 days",
    );
    expect(hostTailscaleNotice("Mac mini", status([expiring]), NOW + 4 * 24 * HOUR)?.headline).toBe(
      "The Tailscale node key on Mac mini has expired (as of 4 days ago)",
    );
    const outdated = { cause: "outdated", fix: "Update Tailscale." } as const;
    expect(hostTailscaleNotice("Mac mini", status([https, outdated]), NOW)?.headline).toBe(
      "Tailscale on Mac mini is too old for Tailscale sign-in",
    );
  });
});

describe("offTailnetHint", () => {
  it("hints only when every Tailscale route failed and something else works", () => {
    const connected: SupervisorConnectionState = {
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "connected",
      routes: [TAILNET_FAILED, RELAY_ANSWERED],
    };
    expect(offTailnetHint(connected)).toBe("Check that Tailscale is on for this device.");
    const offline = { ...connected, network: "offline" as const, routes: [TAILNET_FAILED] };
    expect(offTailnetHint(offline)).toBeNull();
    // A host that is off fails every route while this device is online.
    expect(offTailnetHint({ ...offline, network: "online" })).toBeNull();
    expect(offTailnetHint({ ...connected, routes: [RELAY_ANSWERED] })).toBeNull();
    // The host answered on Tailscale and failed for its own reason.
    const hostFailed: ConnectionRouteOutcome = {
      ...TAILNET_FAILED,
      error: new ConnectionTransientError({ reason: "remote-unavailable", detail: "500" }),
    };
    expect(offTailnetHint({ ...connected, routes: [hostFailed, RELAY_ANSWERED] })).toBeNull();
  });

  it("keeps the relay health status out of a failure that has its own cause", () => {
    const failure = mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
    );
    const diagnosis = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: backoff(failure),
      via: "direct",
      relayStatus: { status: "offline", endpointFailure: "tunnel_down", endpointStatus: 530 },
    });
    expect(diagnosis?.facts.map(([label]) => label)).not.toContain("HTTP status");
  });
});
