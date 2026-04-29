import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ClientSettingsPatch, ClientSettingsSchema } from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("ClientSettings", () => {
  it("defaults desktop attention notification settings to false", () => {
    const parsed = decodeClientSettings({});

    expect(parsed.desktopNotifyOnApprovalRequests).toBe(false);
    expect(parsed.desktopNotifyOnUserInputRequests).toBe(false);
  });

  it("accepts desktop attention notification patches independently", () => {
    expect(
      decodeClientSettingsPatch({
        desktopNotifyOnApprovalRequests: true,
      }),
    ).toEqual({
      desktopNotifyOnApprovalRequests: true,
    });

    expect(
      decodeClientSettingsPatch({
        desktopNotifyOnUserInputRequests: true,
      }),
    ).toEqual({
      desktopNotifyOnUserInputRequests: true,
    });
  });
});
