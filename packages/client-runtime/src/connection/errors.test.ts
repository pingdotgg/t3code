import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import { RelayAuthInvalidError } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import { mapManagedRelayError, mapRemoteEnvironmentError } from "./errors.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";

describe("connection error mapping", () => {
  it("retains the managed relay request as the cause when classifying a protected error", () => {
    const relayError = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_bearer",
      traceId: "relay-trace-id",
    });
    const source = new ManagedRelay.ManagedRelayRequestFailedError({
      action: "connect relay environment",
      cause: relayError,
      relayError,
      traceId: relayError.traceId,
    });

    const error = mapManagedRelayError(source);

    expect(error).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "authentication",
      traceId: "relay-trace-id",
    });
    expect(error.cause).toBe(source);
  });

  it("retains a managed relay timeout and its structured activity", () => {
    const source = new ManagedRelay.ManagedRelayRequestTimeoutError({
      activity: "Relay environment connection",
      timeoutMs: 10_000,
    });

    const error = mapManagedRelayError(source);

    expect(error).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "timeout",
    });
    expect(error.cause).toBe(source);
    expect(source.activity).toBe("Relay environment connection");
  });

  it("retains structured remote authorization failures", () => {
    const source = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "environment-trace-id",
    });

    const error = mapRemoteEnvironmentError(source);

    expect(error).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "authentication",
      traceId: "environment-trace-id",
    });
    expect(error.cause).toBe(source);
  });

  it("retains local transport failures without deriving their message from the cause", () => {
    const transportCause = new Error("sensitive transport implementation detail");
    const source = new RemoteEnvironmentAuthFetchError({
      requestUrl: "https://environment.example.test/api/auth/session",
      cause: transportCause,
    });

    const error = mapRemoteEnvironmentError(source);

    expect(source.message).toBe(
      "Failed to fetch remote environment endpoint https://environment.example.test/api/auth/session.",
    );
    expect(source.message).not.toContain(transportCause.message);
    expect(error).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "network",
    });
    expect(error.cause).toBe(source);
    expect(source.cause).toBe(transportCause);
  });
});
