import { describe, expect, it } from "vite-plus/test";
import * as PlatformError from "effect/PlatformError";

import { SecretStorePersistError } from "./ServerSecretStore.ts";
import { mapDpopReplayStoreError } from "./dpop.ts";

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
