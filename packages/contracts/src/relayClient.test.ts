import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { RelayClientInstallFailedError } from "./relayClient.ts";

const encodeRelayClientInstallFailedError = Schema.encodeSync(RelayClientInstallFailedError);
const decodeRelayClientInstallFailedError = Schema.decodeUnknownSync(RelayClientInstallFailedError);

describe("RelayClientInstallFailedError", () => {
  it("retains its internal cause without serializing it", () => {
    const cause = new Error("private download failure");
    const error = new RelayClientInstallFailedError({
      reason: "download_failed",
      cause,
    });

    const encoded = encodeRelayClientInstallFailedError(error);
    const decoded = decodeRelayClientInstallFailedError(encoded);

    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Relay client installation failed (download_failed).");
    expect(encoded).toEqual({
      _tag: "RelayClientInstallFailedError",
      reason: "download_failed",
    });
    expect(decoded.cause).toBeUndefined();
    expect(decoded.message).toBe("Relay client installation failed (download_failed).");
  });
});
