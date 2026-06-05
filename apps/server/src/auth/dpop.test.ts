import { describe, expect, it } from "vite-plus/test";
import * as PlatformError from "effect/PlatformError";

import * as ServerSecretStore from "./ServerSecretStore.ts";
import { mapDpopReplayStoreError } from "./dpop.ts";

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new ServerSecretStore.SecretStoreError({
    message: "Failed to persist DPoP proof.",
    cause: PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "dpop-proof.bin",
    }),
  });

describe("mapDpopReplayStoreError", () => {
  it("reports replay conflicts as invalid credentials", () => {
    const error = mapDpopReplayStoreError(storeFailure("AlreadyExists"));

    expect(error._tag).toBe("ServerAuthInvalidCredentialError");
  });

  it("reports replay-store availability failures as internal errors", () => {
    const error = mapDpopReplayStoreError(storeFailure("PermissionDenied"));

    expect(error._tag).toBe("ServerAuthInternalError");
    if (error._tag === "ServerAuthInternalError") {
      expect(error.message).toBe("Failed to record DPoP proof replay state.");
    }
  });
});
