import {
  RelayAuthInvalidError,
  RelayEnvironmentLinkProofExpiredError,
  RelayEnvironmentLinkProofInvalidError,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import {
  DPOP_CLOCK_HINT,
  DPOP_RETRY_HINT,
  DPOP_UNKNOWN_HINT,
  relayProtectedErrorMessage,
} from "./errorPresentation.ts";

describe("relayProtectedErrorMessage", () => {
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
  it("points clients to the host clock only when a link proof could have a time failure", () => {
    const expired = new RelayEnvironmentLinkProofExpiredError({
      code: "environment_link_proof_expired",
      traceId: "trace-expired",
    });
    const invalid = new RelayEnvironmentLinkProofInvalidError({
      code: "environment_link_proof_invalid",
      reason: "invalid_signature_or_scope",
      traceId: "trace-invalid",
    });
    const mismatch = new RelayEnvironmentLinkProofInvalidError({
      code: "environment_link_proof_invalid",
      reason: "descriptor_mismatch",
      traceId: "trace-mismatch",
    });

    expect(relayProtectedErrorMessage(expired)).toContain(
      "computer running T3 Code sets its date and time automatically",
    );
    expect(relayProtectedErrorMessage(invalid)).toContain(
      "computer running T3 Code sets its date and time automatically",
    );
    expect(relayProtectedErrorMessage(mismatch)).toBe(
      "Relay rejected the environment link proof (descriptor_mismatch).",
    );
  });
});
