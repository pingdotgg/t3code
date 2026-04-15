import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings";

describe("DEFAULT_CLIENT_SETTINGS", () => {
  it("includes archive confirmation with a false default", () => {
    expect(DEFAULT_CLIENT_SETTINGS.confirmThreadArchive).toBe(false);
  });
});

describe("DEFAULT_SERVER_SETTINGS", () => {
  it("includes an empty terminal profile by default", () => {
    expect(DEFAULT_SERVER_SETTINGS.terminal.profile.shellPath).toBe("");
    expect(DEFAULT_SERVER_SETTINGS.terminal.profile.shellArgs).toEqual([]);
    expect(DEFAULT_SERVER_SETTINGS.terminal.profile.env).toEqual({});
  });

  it("decodes terminal profile defaults when omitted", () => {
    const settings = Schema.decodeSync(ServerSettings)({});

    expect(settings.terminal.profile.shellPath).toBe("");
    expect(settings.terminal.profile.shellArgs).toEqual([]);
    expect(settings.terminal.profile.env).toEqual({});
  });
});
