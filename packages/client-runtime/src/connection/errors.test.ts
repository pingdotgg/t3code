import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import {
  RelayAuthInvalidError,
  RelayEnvironmentEndpointTimedOutError,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import {
  mapManagedRelayError,
  mapRemoteDpopEnvironmentError,
  mapRemoteEnvironmentError,
} from "./errors.ts";
import { DPOP_RETRY_HINT, DPOP_UNKNOWN_HINT } from "../relay/errorPresentation.ts";
import { ManagedRelayRequestFailedError } from "../relay/managedRelay.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import { RemoteEnvironmentAuthFetchError, RemoteEnvironmentAuthTimeoutError } from "../rpc/http.ts";

describe("mapManagedRelayError", () => {
  it("keeps a timeout reported by the relay distinct from a local network failure", () => {
    const relayError = new RelayEnvironmentEndpointTimedOutError({
      code: "environment_endpoint_timed_out",
      traceId: "trace-server-timeout",
    });
    const mapped = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        cause: relayError,
        relayError,
      }),
    );
    expect(mapped).toMatchObject({
      reason: "timeout",
      detail: "Relay timed out while contacting the environment endpoint.",
      traceId: "trace-server-timeout",
    });
  });

  it("presents clock skew as one possible cause for a generic DPoP error", () => {
    const mapped = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        cause: new Error("request failed"),
        relayError: new RelayAuthInvalidError({
          code: "auth_invalid",
          reason: "invalid_dpop",
          traceId: "trace-1",
        }),
        traceId: "trace-1",
      }),
    );

    expect(mapped).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "authentication",
      detail: `Relay rejected the DPoP proof. ${DPOP_UNKNOWN_HINT}`,
      traceId: "trace-1",
    });
  });

  it("uses a neutral hint when the relay identifies a non-clock DPoP error", () => {
    const mapped = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        cause: new Error("request failed"),
        relayError: new RelayAuthInvalidError({
          code: "auth_invalid",
          reason: "invalid_dpop",
          dpopFailureReason: "key_mismatch",
          traceId: "trace-1",
        }),
      }),
    );

    expect(mapped.message).toBe(`Relay rejected the DPoP proof. ${DPOP_RETRY_HINT}`);
  });
});

describe("mapRemoteDpopEnvironmentError", () => {
  it("keeps relay descriptor auth failures distinct from DPoP proof failures", () => {
    const error = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-descriptor",
    });
    expect(mapRemoteEnvironmentError(error, "relay").message).toBe(
      "The environment credential is invalid.",
    );
    expect(mapRemoteDpopEnvironmentError(error).message).toBe(
      `The environment credential is invalid. ${DPOP_UNKNOWN_HINT}`,
    );
  });

  it.each([
    new RemoteEnvironmentAuthFetchError({
      message: "Failed to fetch remote environment endpoint.",
      cause: new TypeError("Failed to fetch"),
    }),
    new RemoteEnvironmentAuthTimeoutError("https://environment.example.test", 10_000),
  ])("suggests another network when the relay endpoint cannot be reached: $_tag", (error) => {
    const mapped = mapRemoteDpopEnvironmentError(error);
    expect(mapped).toMatchObject({
      _tag: "ConnectionTransientError",
      detail: `${error.message} ${NETWORK_BLOCKING_HINT}`,
    });
  });

  it("does not present a generic environment auth error as confirmed clock skew", () => {
    const mapped = mapRemoteDpopEnvironmentError(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "trace-1",
      }),
    );

    expect(mapped.message).toBe(`The environment credential is invalid. ${DPOP_UNKNOWN_HINT}`);
  });

  it("uses a neutral hint for a non-clock DPoP error from a new server", () => {
    const mapped = mapRemoteDpopEnvironmentError(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        dpopFailureReason: "key_mismatch",
        traceId: "trace-1",
      }),
    );

    expect(mapped.message).toBe(`The environment credential is invalid. ${DPOP_RETRY_HINT}`);
  });
});
