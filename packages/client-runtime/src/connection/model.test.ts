import { describe, expect, it } from "vite-plus/test";

import {
  ConnectionStorageOperationError,
  ConnectionTransientError,
  IndexedDbUnavailableError,
} from "./model.ts";

describe("ConnectionTransientError.fromStorageFailure", () => {
  it("preserves structured operation context and the complete failure chain", () => {
    const storageCause = new Error("quota exceeded");
    const storageOperationCause = new ConnectionStorageOperationError({
      operation: "write",
      backend: "indexed-db",
      storeName: "catalog",
      cause: storageCause,
    });

    const error = ConnectionTransientError.fromStorageFailure(storageOperationCause);

    expect(error).toMatchObject({
      reason: "remote-unavailable",
      cause: {
        _tag: "ConnectionStorageOperationError",
        operation: "write",
        backend: "indexed-db",
        storeName: "catalog",
        cause: storageCause,
      },
    });
    expect(error.message).toBe("Could not write local connection data.");
  });

  it("maps a cause-free availability failure without inventing a defect", () => {
    const error = ConnectionTransientError.fromStorageFailure(new IndexedDbUnavailableError());

    expect(error.cause).toMatchObject({ _tag: "IndexedDbUnavailableError" });
    expect((error.cause as IndexedDbUnavailableError).cause).toBeUndefined();
  });
});
