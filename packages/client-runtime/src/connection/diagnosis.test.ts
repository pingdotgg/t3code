import {
  RelayAuthInvalidError,
  RelayEnvironmentEndpointTimedOutError,
  RelayEnvironmentEndpointUnavailableError,
  type RelayProtectedError,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import { connectionDiagnosisText, presentConnectionDiagnosis } from "./diagnosis.ts";
import {
  credentialMissingError,
  mapManagedRelayError,
  mapRemoteEnvironmentError,
} from "./errors.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionAttemptError,
  type SupervisorConnectionState,
} from "./model.ts";
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

const diagnose = (state: SupervisorConnectionState, via: "relay" | "direct" = "relay") =>
  presentConnectionDiagnosis({ hostLabel: "Mac mini", state, via });

const results = (state: SupervisorConnectionState, via?: "relay" | "direct") =>
  diagnose(state, via)?.hops.map((hop) => `${hop.hop}:${hop.result}`);

describe("presentConnectionDiagnosis", () => {
  it("names a dead tunnel and points the fix at the host", () => {
    const diagnosis = diagnose(backoff(unavailable("tunnel_down")));
    expect(diagnosis?.headline).toBe("Mac mini's tunnel is offline");
    expect(results(backoff(unavailable("tunnel_down")))).toEqual([
      "device:ok",
      "relay:ok",
      "tunnel:failed",
      "server:unchecked",
    ]);
    expect(diagnosis?.steps.join(" ")).toContain("Tailscale exit node on Mac mini");
    expect(diagnosis?.facts).toContainEqual(["HTTP status", "530"]);
    expect(diagnosis?.facts).toContainEqual(["Trace ID", "trace-1"]);
  });

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

  it("points a relay timeout at the host, not this device", () => {
    const failure = fromRelay(
      new RelayEnvironmentEndpointTimedOutError({
        code: "environment_endpoint_timed_out",
        traceId: "trace-3",
      }),
    );
    const diagnosis = diagnose(backoff(failure));
    expect(diagnosis?.headline).toBe("Mac mini did not answer in time");
    expect(diagnosis?.steps.join(" ")).toContain("On Mac mini");
    expect(diagnosis?.steps.join(" ")).not.toContain("on this device");
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

  it("blames this device when its saved credential is missing", () => {
    const diagnosis = diagnose(backoff(credentialMissingError("connection-1")), "direct");
    expect(diagnosis?.hops[0]).toMatchObject({ hop: "device", result: "failed" });
  });

  it("names clock skew from a DPoP time window rejection", () => {
    const failure = fromRelay(
      new RelayAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_dpop",
        dpopFailureReason: "time_window",
        traceId: "trace-2",
      }),
    );
    expect(diagnose(backoff(failure))?.headline).toBe("This device's clock is off");
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
      via: "direct",
      relayStatus: { status: "offline", endpointFailure: "origin_unreachable" },
    });
    expect(origin?.hops.map((hop) => hop.hop)).toEqual(["device", "relay", "tunnel", "server"]);
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

  it("has nothing to say when nothing failed", () => {
    expect(diagnose(AVAILABLE_CONNECTION_STATE)).toBeNull();
  });

  it("writes every hop and fact into the copied diagnostics", () => {
    const diagnosis = diagnose(backoff(unavailable("tunnel_down")));
    if (diagnosis === null) throw new Error("expected a diagnosis");
    const text = connectionDiagnosisText("Mac mini", diagnosis);
    expect(text).toContain("Mac mini tunnel: FAILED");
    expect(text).toContain("T3 Code on Mac mini: not checked");
    expect(text).toContain("Cause: tunnel_down");
    expect(text).toContain("Attempts: 3");
  });
});
