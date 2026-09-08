import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HostResourcesSnapshot } from "./resourceTelemetry.ts";

const decode = Schema.decodeUnknownSync(HostResourcesSnapshot);
const resources = {
  sampledAt: 0,
  cpuUtilization: null,
  cpuCount: 4,
  availableMemoryBytes: 1024,
  totalMemoryBytes: 2048,
};

describe("HostResourcesSnapshot storage", () => {
  it("accepts older servers without storage and unavailable readings", () => {
    expect(decode(resources)).toEqual(resources);
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
