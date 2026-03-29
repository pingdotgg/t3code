import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_FOLLOW_UP_BEHAVIOR,
} from "./settings";

describe("client follow-up behavior settings", () => {
  it("defaults follow-up behavior to steer", () => {
    expect(DEFAULT_CLIENT_SETTINGS.followUpBehavior).toBe(DEFAULT_FOLLOW_UP_BEHAVIOR);
    expect(Schema.decodeSync(ClientSettingsSchema)({}).followUpBehavior).toBe("steer");
  });
});

describe("DEFAULT_CLIENT_SETTINGS", () => {
  it("includes archive confirmation with a false default", () => {
    expect(DEFAULT_CLIENT_SETTINGS.confirmThreadArchive).toBe(false);
  });
});
