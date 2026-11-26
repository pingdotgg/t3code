import { describe, expect, it } from "vite-plus/test";

import {
  draftSupportedRuntimeModes,
  resolveCompatibleRuntimeMode,
  resolveRuntimeModeOptions,
  runtimeModeOptions,
} from "./runtimeModeConfig";

describe("draftSupportedRuntimeModes", () => {
  const supervisedOnly = {
    instanceId: "fx",
    supportedRuntimeModes: ["approval-required"],
  } as const;
  const noAuto = {
    instanceId: "muse",
    supportedRuntimeModes: ["approval-required", "full-access"],
  } as const;
  const everyMode = { instanceId: "codex" };
  const providers = [supervisedOnly, noAuto, everyMode];

  it.each([
    { label: "one provider that supports it", selections: [supervisedOnly, noAuto] },
    { label: "a provider that reports no modes", selections: [supervisedOnly, everyMode] },
  ])("shows Full access when a multi-model draft includes $label", ({ selections }) => {
    const modes = draftSupportedRuntimeModes(
      supervisedOnly.supportedRuntimeModes,
      selections,
      providers,
    );
    expect(resolveCompatibleRuntimeMode("full-access", modes).mode).toBe("full-access");
  });

  it("falls back only when no selected provider can run the mode", () => {
    const modes = draftSupportedRuntimeModes(undefined, [supervisedOnly, noAuto], providers);
    expect(resolveCompatibleRuntimeMode("auto", modes).mode).toBe("approval-required");
  });
});

describe("resolveRuntimeModeOptions", () => {
  it("keeps a mode the provider cannot run in this folder listed, disabled with the reason", () => {
    const options = resolveRuntimeModeOptions(runtimeModeOptions, undefined, undefined, [
      { mode: "auto", reason: "project-settings" },
    ]);
    expect(options.map((option) => [option.mode, option.disabledReason])).toEqual([
      ["approval-required", undefined],
      ["auto-accept-edits", undefined],
      ["auto", "This project's Claude settings turn auto mode off."],
      ["full-access", undefined],
    ]);
  });
});
