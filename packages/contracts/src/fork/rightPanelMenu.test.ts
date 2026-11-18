import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ClientSettingsSchema } from "../settings.ts";

const decodeClientSettings = Schema.decodeSync(ClientSettingsSchema);

describe("rightPanelMenuOverrides", () => {
  it.each([null, "files", { files: { hidden: "yes" } }])(
    "a malformed stored value %j still decodes the client settings",
    (rightPanelMenuOverrides) => {
      const settings = decodeClientSettings({ rightPanelMenuOverrides });
      expect(settings.rightPanelMenuOverrides).toEqual(rightPanelMenuOverrides);
    },
  );
});
