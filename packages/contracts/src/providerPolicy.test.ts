import { describe, expect, it } from "vite-plus/test";

import { type RuntimeMode, resolveSupportedRuntimeMode } from "./providerPolicy.ts";

const pi: ReadonlyArray<RuntimeMode> = ["approval-required", "auto-accept-edits", "full-access"];
const fx: ReadonlyArray<RuntimeMode> = ["approval-required", "auto"];

describe("resolveSupportedRuntimeMode", () => {
  it.each([
    ["Pi steps Auto down to Auto-accept edits", "auto", pi, "auto-accept-edits"],
    ["a supported mode is kept", "full-access", pi, "full-access"],
    ["Supervised is kept", "approval-required", pi, "approval-required"],
    ["never steps up past the asked mode", "auto-accept-edits", fx, "approval-required"],
    ["a provider that reports no modes keeps the asked mode", "auto", undefined, "auto"],
    ["an empty list keeps the asked mode", "auto", [], "auto"],
  ] satisfies ReadonlyArray<
    [string, RuntimeMode, ReadonlyArray<RuntimeMode> | undefined, RuntimeMode]
  >)("%s", (_name, mode, supported, expected) => {
    expect(resolveSupportedRuntimeMode(mode, supported)).toBe(expected);
  });
});
