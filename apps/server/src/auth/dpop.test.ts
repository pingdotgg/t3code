import { describe, expect, it } from "vite-plus/test";
import * as PlatformError from "effect/PlatformError";

import { SecretStorePersistError } from "./ServerSecretStore.ts";
import { mapDpopReplayStoreError, resolveDpopRequestUrl } from "./dpop.ts";

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

describe("resolveDpopRequestUrl", () => {
  it("uses the configured reverse-proxy base instead of forwarded headers", () => {
    expect(
      resolveDpopRequestUrl({
        localUrl: new URL("http://127.0.0.1:3773/oauth/token?code=one-time"),
        originalUrl: "/oauth/token?code=one-time",
        pairingBaseUrl: new URL("https://app.matrix-os.com/vm/alice/api/integrations/t3/"),
      }),
    ).toBe("https://app.matrix-os.com/vm/alice/api/integrations/t3/oauth/token?code=one-time");
  });
});
