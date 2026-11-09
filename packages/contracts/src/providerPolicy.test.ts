import { describe, expect, it } from "vite-plus/test";

import { type RuntimeMode, resolveSupportedRuntimeMode } from "./providerPolicy.ts";

const pi: ReadonlyArray<RuntimeMode> = ["full-access", "auto-accept-edits", "approval-required"];
const fx: ReadonlyArray<RuntimeMode> = ["approval-required", "auto"];

describe("resolveSupportedRuntimeMode", () => {
  it.each([
    ["Pi steps Auto down to Auto-accept edits", "auto", pi, "auto-accept-edits"],
    ["fx steps Full access down to Auto", "full-access", fx, "auto"],
    ["a supported mode is kept", "full-access", pi, "full-access"],
    ["never steps up past the asked mode", "auto-accept-edits", fx, "approval-required"],
    ["a provider that reports no modes keeps the asked mode", "auto", undefined, "auto"],
    ["an empty list keeps the asked mode", "auto", [], "auto"],
  ] satisfies ReadonlyArray<
    [string, RuntimeMode, ReadonlyArray<RuntimeMode> | undefined, RuntimeMode]
  >)("%s", (_name, mode, supported, expected) => {
    expect(resolveSupportedRuntimeMode(mode, supported)).toBe(expected);
  });
});
