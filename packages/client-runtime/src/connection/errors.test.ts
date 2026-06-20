import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import { RelayAuthInvalidError } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import { mapManagedRelayError, mapRemoteEnvironmentError } from "./errors.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthUndeclaredStatusError,
} from "../rpc/http.ts";

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
    const requestUrl =
      "https://environment-user:environment-password@environment.example.test/private/session?access_token=environment-secret#environment-fragment";
    const source = RemoteEnvironmentAuthFetchError.fromRequestUrl(requestUrl, transportCause);

    const error = mapRemoteEnvironmentError(source);

    expect(source.message).toBe(
      `Failed to fetch remote environment endpoint at host environment.example.test (${requestUrl.length} URL characters).`,
    );
    expect(source.message).not.toContain(transportCause.message);
    expect(error).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "network",
    });
    expect(error.cause).toBe(source);
    expect(source.cause).toBe(transportCause);
    expect(source).toMatchObject({
      requestUrlInputLength: requestUrl.length,
      requestUrlProtocol: "https:",
      requestUrlHostname: "environment.example.test",
    });
    const diagnostics = JSON.stringify(source);
    for (const secret of [
      "environment-user",
      "environment-password",
      "/private/session",
      "environment-secret",
      "environment-fragment",
    ]) {
      expect(diagnostics).not.toContain(secret);
      expect(source.message).not.toContain(secret);
    }
  });

  it("retains the HTTP client cause for undeclared statuses", () => {
    const cause = new Error("upstream response metadata");
    const requestUrl =
      "https://environment-user:environment-password@environment.example.test/private/session?access_token=environment-secret#environment-fragment";
    const error = RemoteEnvironmentAuthUndeclaredStatusError.fromRequestUrl(requestUrl, 502, cause);

    expect(error).toMatchObject({
      status: 502,
      requestUrlInputLength: requestUrl.length,
      requestUrlProtocol: "https:",
      requestUrlHostname: "environment.example.test",
    });
    expect(error.cause).toBe(cause);
    expect(error).not.toHaveProperty("requestUrl");
  });
});
