import { describe, expect, it } from "vite-plus/test";
import * as PlatformError from "effect/PlatformError";

import { SecretStorePersistError } from "./ServerSecretStore.ts";
import { mapDpopFailureReason, mapDpopReplayStoreError } from "./dpop.ts";

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new SecretStorePersistError({
    resource: "DPoP proof",
    cause: PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "dpop-proof.bin",
    }),
  });

describe("mapDpopReplayStoreError", () => {
  it("reports replay conflicts as invalid credentials", () => {
    const cause = storeFailure("AlreadyExists");
    const error = mapDpopReplayStoreError(cause);

    expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    if (error._tag === "ServerAuthInvalidCredentialError") {
      expect(error.cause).toBe(cause);
      expect(error.dpopFailureReason).toBe("replay");
    }
  });

  it("reports replay-store availability failures as internal errors", () => {
    const error = mapDpopReplayStoreError(storeFailure("PermissionDenied"));

    expect(error._tag).toBe("ServerAuthDpopReplayStateRecordError");
    if (error._tag === "ServerAuthDpopReplayStateRecordError") {
      expect(error.message).toBe("Failed to record DPoP proof replay state.");
    }
  });
});

describe("mapDpopFailureReason", () => {
  it("maps verifier failures to safe client-facing categories", () => {
    const mappings = [
      ["time_window", "time_window"],
      ["key_mismatch", "key_mismatch"],
      ["method_mismatch", "request_mismatch"],
      ["url_mismatch", "request_mismatch"],
      ["access_token_hash_mismatch", "token_mismatch"],
      ["missing_proof", "invalid_proof"],
      ["malformed_proof", "invalid_proof"],
      ["invalid_signature", "invalid_proof"],
      ["invalid_proof", "invalid_proof"],
    ] as const;

    for (const [code, expected] of mappings) {
      expect(mapDpopFailureReason(code)).toBe(expected);
    }
  });
});
