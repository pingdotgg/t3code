import {
  RelayAuthInvalidError,
  RelayEnvironmentLinkUnavailableError,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  DPOP_CLOCK_HINT,
  DPOP_RETRY_HINT,
  DPOP_UNKNOWN_HINT,
  relayProtectedErrorMessage,
} from "./errorPresentation.ts";

const decodeLinkUnavailableError = Schema.decodeUnknownSync(RelayEnvironmentLinkUnavailableError);

describe("relayProtectedErrorMessage", () => {
  it("decodes older relay failures and preserves their reason-only message", () => {
    const error = decodeLinkUnavailableError({
      _tag: "RelayEnvironmentLinkUnavailableError",
      code: "environment_link_unavailable",
      reason: "managed_endpoint_provisioning_failed",
      traceId: "trace-1",
    });

    expect(error.traceId).toBe("trace-1");
    expect(relayProtectedErrorMessage(error)).toBe(
      "Relay cannot provision the managed endpoint (managed_endpoint_provisioning_failed).",
    );
  });

  it("presents clock skew as one possible cause when the relay omits the reason", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe(
      `Relay rejected the DPoP proof. ${DPOP_UNKNOWN_HINT}`,
    );
  });

  it("keeps the clock hint for a relay that confirms a time-window failure", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      dpopFailureReason: "time_window",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toContain(DPOP_CLOCK_HINT);
  });

  it("does not blame the clock when the relay identifies another proof failure", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      dpopFailureReason: "key_mismatch",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe(
      `Relay rejected the DPoP proof. ${DPOP_RETRY_HINT}`,
    );
  });

  it("preserves the existing message for other authentication failures", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_bearer",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe("Relay rejected the cloud session token.");
  });
});
