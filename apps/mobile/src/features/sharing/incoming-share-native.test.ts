import { describe, expect, it, vi } from "@effect/vitest";
import type { SharePayload } from "expo-sharing";

import { createIncomingSharePayloadReader } from "./incoming-share-native";

const PAYLOAD: SharePayload = {
  shareType: "text",
  mimeType: "text/plain",
  value: "Fix this",
};

describe("createIncomingSharePayloadReader", () => {
  it("treats a missing iOS App Group as an unavailable inbox", () => {
    const readPayloads = vi.fn((): ReadonlyArray<SharePayload> => {
      throw Object.assign(new Error("Expo-sharing has failed to fetch the app group id"), {
        code: "ERR_FAILED_TO_RESOLVE_APP_GROUP_ID",
      });
    });
    const read = createIncomingSharePayloadReader({ platform: "ios", readPayloads });

    expect(read()).toEqual([]);
    expect(read()).toEqual([]);
    expect(readPayloads).toHaveBeenCalledTimes(1);
  });

  it("returns native payloads when receiving is available", () => {
    const read = createIncomingSharePayloadReader({
      platform: "ios",
      readPayloads: () => [PAYLOAD],
    });

    expect(read()).toEqual([PAYLOAD]);
  });

  it("preserves other native errors", () => {
    const error = new Error("native failure");
    const read = createIncomingSharePayloadReader({
      platform: "ios",
      readPayloads: () => {
        throw error;
      },
    });

    expect(read).toThrow(error);
  });
});
