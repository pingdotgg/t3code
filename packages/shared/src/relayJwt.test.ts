import { describe, expect, it } from "@effect/vitest";

import { RelayJwtError } from "./relayJwt.ts";

describe("relayJwt", () => {
  it("extracts stable diagnostic codes without copying cause text into the error message", () => {
    const error = new RelayJwtError({
      operation: "verify",
      typ: "test+jwt",
      cause: { code: "ERR_JWT_EXPIRED", message: "sensitive library detail" },
    });

    expect(RelayJwtError.diagnosticCode(error)).toBe("ERR_JWT_EXPIRED");
    expect(error.message).not.toContain("sensitive library detail");
  });
});
