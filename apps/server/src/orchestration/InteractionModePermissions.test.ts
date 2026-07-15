import { expect, it } from "vite-plus/test";

import {
  isNonMutatingInteractionMode,
  resolveEffectiveRuntimeMode,
} from "./InteractionModePermissions.ts";

it("identifies Advisor as non-mutating", () => {
  expect(isNonMutatingInteractionMode("advisor")).toBe(true);
  expect(isNonMutatingInteractionMode("plan")).toBe(false);
  expect(isNonMutatingInteractionMode("default")).toBe(false);
});

it("clamps Advisor runtime permissions to approval-required", () => {
  for (const runtimeMode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
    expect(resolveEffectiveRuntimeMode(runtimeMode, "advisor")).toBe("approval-required");
    expect(resolveEffectiveRuntimeMode(runtimeMode, "plan")).toBe(runtimeMode);
    expect(resolveEffectiveRuntimeMode(runtimeMode, "default")).toBe(runtimeMode);
    expect(resolveEffectiveRuntimeMode(runtimeMode, undefined)).toBe(runtimeMode);
  }
});
