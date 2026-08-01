import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PreviewLiveGatewayOpenInput,
  PreviewLiveGatewayOpenResult,
  PreviewLiveGatewayUnavailableError,
} from "./preview.ts";

const decodeInput = Schema.decodeUnknownSync(PreviewLiveGatewayOpenInput);
const decodeResult = Schema.decodeUnknownSync(PreviewLiveGatewayOpenResult);
const decodeUnavailable = Schema.decodeUnknownSync(PreviewLiveGatewayUnavailableError);

describe("preview live gateway contracts", () => {
  it("targets one exact versioned preview tab", () => {
    expect(
      decodeInput({
        version: 1,
        threadId: "thread-1",
        tabId: "tab-1",
      }),
    ).toEqual({
      version: 1,
      threadId: "thread-1",
      tabId: "tab-1",
    });
    expect(() => decodeInput({ version: 1, threadId: "thread-1" })).toThrow();
  });

  it("accepts only same-environment relative bootstrap URLs", () => {
    expect(
      decodeResult({
        version: 1,
        relativeUrl: "/api/preview-gateway/bootstrap/opaque-token",
        expiresAt: 1_785_369_600_000,
      }),
    ).toEqual({
      version: 1,
      relativeUrl: "/api/preview-gateway/bootstrap/opaque-token",
      expiresAt: 1_785_369_600_000,
    });
    expect(() =>
      decodeResult({
        version: 1,
        relativeUrl: "https://attacker.example/bootstrap",
        expiresAt: 1_785_369_600_000,
      }),
    ).toThrow();
  });

  it("serializes stable unavailability reasons", () => {
    for (const reason of [
      "runtime_unsupported",
      "session_expired",
      "target_not_loopback",
    ] as const) {
      expect(
        decodeUnavailable({
          _tag: "PreviewLiveGatewayUnavailableError",
          threadId: "thread-1",
          tabId: "tab-1",
          reason,
        }),
      ).toMatchObject({
        threadId: "thread-1",
        tabId: "tab-1",
        reason,
      });
    }
  });
});
