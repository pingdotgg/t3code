import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import { RelayAuthInvalidError } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import { mapManagedRelayError, mapRemoteDpopEnvironmentError } from "./errors.ts";
import { DPOP_RETRY_HINT, DPOP_UNKNOWN_HINT } from "../relay/errorPresentation.ts";
import { ManagedRelayRequestFailedError } from "../relay/managedRelay.ts";

describe("mapManagedRelayError", () => {
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
