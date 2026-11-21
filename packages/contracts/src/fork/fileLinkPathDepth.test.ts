import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ClientSettingsSchema } from "../settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);

describe("fileLinkPathDepth", () => {
  it("defaults to the file name alone", () => {
    expect(decodeClientSettings({}).fileLinkPathDepth).toBe(1);
  });

  it.each([9, 0, 2.5, "2", null, { depth: 2 }])(
    "a bad stored depth %j decodes to 1 and keeps the other settings",
    (fileLinkPathDepth) => {
      const settings = decodeClientSettings({ fileLinkPathDepth, wordWrap: false });
      expect(settings.fileLinkPathDepth).toBe(1);
      expect(settings.wordWrap).toBe(false);
    },
  );

  it("round-trips a valid depth", () => {
    const settings = decodeClientSettings({ fileLinkPathDepth: 3 });
    expect(settings.fileLinkPathDepth).toBe(3);
    expect(decodeClientSettings(encodeClientSettings(settings)).fileLinkPathDepth).toBe(3);
  });
});
