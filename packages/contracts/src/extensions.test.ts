import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ExtensionApiSubscribeInput, ExtensionApiStreamFrame } from "./extensions.ts";
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
