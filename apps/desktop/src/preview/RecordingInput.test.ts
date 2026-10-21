import { describe, expect, it } from "vite-plus/test";
import { recordingKeysAreSensitive } from "./RecordingInput.ts";

describe("recording key privacy", () => {
  const field = (type: string) => ({ tagName: "INPUT", getAttribute: () => type });
  const sensitive = (activeElement: unknown) =>
    recordingKeysAreSensitive({ activeElement } as Document);
  it("excludes password fields and their shadow-root focus", () => {
    expect(sensitive(field("password"))).toBe(true);
    expect(sensitive({ shadowRoot: { activeElement: field("password") } })).toBe(true);
    expect(sensitive(field("text"))).toBe(false);
  });
  it("excludes iframe focus whose field cannot be inspected", () => {
    expect(sensitive({ tagName: "IFRAME" })).toBe(true);
    expect(sensitive({ tagName: "SECRET-FIELD" })).toBe(true);
  });
});
