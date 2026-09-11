import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HostStorageResult } from "./resourceTelemetry.ts";

const decode = Schema.decodeUnknownSync(HostStorageResult);
const resources = { sampledAt: 0 };

describe("HostStorageResult storage", () => {
  it("accepts unavailable readings", () => {
    expect(decode({ ...resources, storage: null }).storage).toBeNull();
  });

  it("accepts a full filesystem with zero available bytes", () => {
    const storage = { totalBytes: 4096, availableBytes: 0 };
    expect(decode({ ...resources, storage }).storage).toEqual(storage);
  });

  it.each([
    { totalBytes: 0, availableBytes: 0 },
    { totalBytes: -1, availableBytes: 0 },
    { totalBytes: 4096, availableBytes: -1 },
    { totalBytes: 4096, availableBytes: 4097 },
    { totalBytes: 1.5, availableBytes: 0 },
    { totalBytes: 4096, availableBytes: 1.5 },
    { totalBytes: Number.MAX_SAFE_INTEGER + 1, availableBytes: 0 },
    { totalBytes: Infinity, availableBytes: 0 },
    { totalBytes: 4096, availableBytes: NaN },
  ])("rejects invalid capacity %j", (storage) => {
    expect(() => decode({ ...resources, storage })).toThrow();
  });
});
