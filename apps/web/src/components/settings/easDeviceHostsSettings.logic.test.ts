import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";

import { newEasDeviceHost, parseEasDeviceHostDraft } from "./easDeviceHostsSettings.logic";

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
});
