import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ClientSettingsPatch, ClientSettingsSchema } from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("ClientSettings", () => {
  it("defaults the app icon to the current build icon", () => {
    const parsed = decodeClientSettings({});

    expect(parsed.appIcon).toBe("default");
  });

  it("normalizes legacy build-specific app icon values to the current build icon", () => {
    expect(decodeClientSettings({ appIcon: "forma-prod" }).appIcon).toBe("default");
    expect(decodeClientSettings({ appIcon: "forma-dev" }).appIcon).toBe("default");
    expect(decodeClientSettings({ appIcon: "forma-nightly" }).appIcon).toBe("default");
  });

  it("defaults desktop attention notification settings to false", () => {
    const parsed = decodeClientSettings({});

    expect(parsed.desktopNotifyOnApprovalRequests).toBe(false);
    expect(parsed.desktopNotifyOnUserInputRequests).toBe(false);
  });

  it("accepts desktop attention notification patches independently", () => {
    expect(
      decodeClientSettingsPatch({
        appIcon: "forma-prod",
      }),
    ).toEqual({
      appIcon: "default",
    });

    expect(
      decodeClientSettingsPatch({
        appIcon: "forma-blueprint",
      }),
    ).toEqual({
      appIcon: "forma-blueprint",
    });

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
