import { describe, expect, it } from "vite-plus/test";
import * as PlatformError from "effect/PlatformError";

import { SecretStorePersistError } from "./ServerSecretStore.ts";
import { mapDpopReplayStoreError } from "./dpop.ts";

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new SecretStorePersistError({
    operation: "create",
    secretName: "DPoP proof",
    secretPath: "dpop-proof.bin",
    cause: PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "dpop-proof.bin",
    }),
  });

const replayContext = {
  proofKeyThumbprint: "proof-key-thumbprint",
  proofId: "proof-id",
  replayKey: "replay-key",
};

describe("mapDpopReplayStoreError", () => {
  it("reports replay conflicts as invalid credentials", () => {
    const cause = storeFailure("AlreadyExists");
    const error = mapDpopReplayStoreError(cause, replayContext);

    expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    if (error._tag === "ServerAuthInvalidCredentialError") {
      expect(error.cause).toBe(cause);
    }
  });

  it("reports replay-store availability failures as internal errors", () => {
    const cause = storeFailure("PermissionDenied");
    const error = mapDpopReplayStoreError(cause, replayContext);

    expect(error._tag).toBe("ServerAuthDpopReplayStateRecordError");
    if (error._tag === "ServerAuthDpopReplayStateRecordError") {
      expect(error.message).toBe(
        "Failed to record replay state for DPoP proof proof-id (proof-key-thumbprint).",
      );
      expect(error.proofKeyThumbprint).toBe(replayContext.proofKeyThumbprint);
      expect(error.proofId).toBe(replayContext.proofId);
      expect(error.replayKey).toBe(replayContext.replayKey);
      expect(error.cause).toBe(cause);
    }
  });
});
