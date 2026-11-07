import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
} from "./ProviderSettingsForm";
import { makeProviderSettingsSchema, TrimmedString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// Field derivation lives in `@t3tools/client-runtime/settings/provider-form-fields`.
// Keep a thin re-export smoke test so web imports stay wired.
describe("ProviderSettingsForm re-exports", () => {
  it("derives annotated fields through the shared helper", () => {
    const settingsSchema = makeProviderSettingsSchema({
      binaryPath: TrimmedString.pipe(
        Schema.annotateKey({
          title: "Binary path",
          providerSettingsForm: { placeholder: "tool" },
        }),
      ),
    });
    expect(deriveProviderSettingsFields({ settingsSchema }).map((field) => field.key)).toEqual([
      "binaryPath",
    ]);
    expect(
      nextProviderConfigWithFieldValue(
        {},
        {
          key: "binaryPath",
          control: "text",
          label: "Binary path",
          clearWhenEmpty: "omit",
        },
        " /bin/tool ",
      ),
    ).toEqual({ binaryPath: " /bin/tool " });
  });
});
