import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";

import {
  newEasDeviceHost,
  parseEasDeviceHostDraft,
  updateEasDeviceHosts,
} from "./easDeviceHostsSettings.logic";

describe("EAS device host settings", () => {
  it("rejects limits EAS does not allow", () => {
    expect(Option.isSome(parseEasDeviceHostDraft(newEasDeviceHost("eas")))).toBe(true);
    expect(
      Option.isNone(parseEasDeviceHostDraft({ ...newEasDeviceHost("eas"), maxSessionMinutes: 10 })),
    ).toBe(true);
    expect(
      Option.isNone(
        parseEasDeviceHostDraft({ ...newEasDeviceHost("eas"), maxSessionMinutes: 600 }),
      ),
    ).toBe(true);
    expect(Option.isNone(parseEasDeviceHostDraft({ ...newEasDeviceHost("eas"), label: " " }))).toBe(
      true,
    );
  });

  it("keeps each environment's own token when a save leaves the token unchanged", () => {
    const edited = { ...newEasDeviceHost("eas"), label: "Renamed", accessToken: "" };
    const elsewhere = { ...newEasDeviceHost("eas"), accessToken: "••••••" };
    expect(updateEasDeviceHosts([elsewhere], edited, false, true)).toEqual([
      { ...edited, accessToken: "••••••" },
    ]);
    expect(updateEasDeviceHosts([], { ...edited, accessToken: "••••••" }, false, true)).toEqual([
      { ...edited, accessToken: "" },
    ]);
  });
});
