import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { mapRemoteEnvironmentError } from "./errors.ts";

describe("mapRemoteEnvironmentError", () => {
  it("names a revoked pairing", () => {
    const mapped = mapRemoteEnvironmentError(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        sessionFailureReason: "revoked",
        traceId: "trace-1",
      }),
    );
    expect(mapped).toMatchObject({ failureCause: "pairing_revoked", hop: "server" });
  });
});
