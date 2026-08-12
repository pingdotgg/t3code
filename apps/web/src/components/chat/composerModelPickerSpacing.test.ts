// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares shipped utility classes.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("composer model picker spacing", () => {
  it("extends the trigger background left without moving its content", () => {
    const composerControlSource = NodeFS.readFileSync(
      new URL("./ComposerControl.tsx", import.meta.url),
      "utf8",
    );
    const chatComposerSource = NodeFS.readFileSync(
      new URL("./ChatComposer.tsx", import.meta.url),
      "utf8",
    );
    const modelPickerCall = chatComposerSource.match(/<ProviderModelPicker[\s\S]*?\/>/)?.[0];
    const modelPickerScrollerClasses = chatComposerSource
      .match(/<div className="([^"]*overflow-x-auto[^"]*)">/)?.[1]
      ?.split(" ");

    expect(composerControlSource).toContain("px-2.5");
    expect(modelPickerCall).toContain('triggerClassName="-ms-2.5"');
    expect(modelPickerCall).not.toContain("ps-0");
    expect(modelPickerScrollerClasses).toEqual(expect.arrayContaining(["-ms-3.5", "ps-3.5"]));
  });
});
