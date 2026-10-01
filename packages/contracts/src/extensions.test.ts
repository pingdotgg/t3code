import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ExtensionApiSubscribeInput,
  ExtensionApiStreamFrame,
  ExtensionGrants,
  ExtensionInstallation,
  ExtensionManageInput,
} from "./extensions.ts";
const input = {
  installationId: "test.consumer",
  expectedContentHash: "a".repeat(64),
  request: {
    id: "test.provider/events",
    versionRange: "^1.0.0",
    name: "changes",
    input: {},
    context: {
      resource: { namespace: "test.consumer", id: "view", environmentId: "env" },
      client: "web",
    },
  },
};
describe("extension API stream wire contracts", () => {
  const request = Schema.decodeUnknownSync(ExtensionApiSubscribeInput);
  const frame = Schema.decodeUnknownSync(ExtensionApiStreamFrame);
  it("requires a content hash and bounds resume and provider identity", () => {
    expect(request(input)).toEqual(input);
    expect(() => request({ ...input, expectedContentHash: "stale" })).toThrow();
    expect(() =>
      request({ ...input, request: { ...input.request, cursor: "x".repeat(1025) } }),
    ).toThrow();
    expect(() =>
      request({ ...input, request: { ...input.request, expectedGeneration: -1 } }),
    ).toThrow();
    expect(() =>
      request({ ...input, request: { ...input.request, expectedGeneration: 0.5 } }),
    ).toThrow();
  });
  it("distinguishes snapshots, data, resets and closure with a positive host sequence", () => {
    for (const type of ["snapshot", "data", "reset", "closed"]) {
      expect(frame({ streamId: "host-stream", sequence: 1, type, value: null }).type).toBe(type);
    }
    expect(() =>
      frame({ streamId: "host-stream", sequence: 0, type: "data", value: null }),
    ).toThrow();
    expect(() =>
      frame({ streamId: "host-stream", sequence: 1, type: "write", value: null }),
    ).toThrow();
  });
});
describe("extension installation grants", () => {
  const decode = Schema.decodeUnknownSync(ExtensionGrants);
  const capabilities = (count: number) =>
    Array.from({ length: count }, (_, index) => `t3.cap${index}/use`);
  it("accepts exactly 32 capabilities and rejects 33", () => {
    const atCap = { capabilities: capabilities(32), projectIds: [] };
    expect(decode(atCap)).toEqual(atCap);
    expect(() => decode({ capabilities: capabilities(33), projectIds: [] })).toThrow();
  });
});
const decodeInstallation = Schema.decodeUnknownSync(ExtensionInstallation);
const decodeManage = Schema.decodeUnknownSync(ExtensionManageInput);
describe("extension installation listing", () => {
  it("accepts any number of derived required grants so one install cannot fail the list", () => {
    // 17 methods x 16 distinct grants is valid API metadata and derives 272.
    const requiredGrants = Array.from({ length: 272 }, (_, index) => `t3.cap${index}/use`);
    const entry = {
      id: "test.consumer",
      contentHash: "a".repeat(64),
      package: {},
      enabled: true,
      grants: { capabilities: [], projectIds: [] },
      requiredGrants,
    };
    expect(decodeInstallation(entry).requiredGrants).toHaveLength(272);
  });
  it("accepts an additive grant action", () => {
    const input = {
      id: "test.consumer",
      action: "addGrants",
      grants: { capabilities: ["t3.cap/use"], projectIds: [] },
    };
    expect(decodeManage(input)).toEqual(input);
  });
});
