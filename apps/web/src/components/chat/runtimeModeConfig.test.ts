import type { ManagedPolicySummary, ServerProviderRuntimeMode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveCompatibleRuntimeMode,
  resolveRuntimeModeOptions,
  runtimeModeOptions,
} from "./runtimeModeConfig";

const SPARROW_MODES: ReadonlyArray<ServerProviderRuntimeMode> = [
  {
    mode: "read-only",
    label: "Read only",
    description: "Allow read and search tools only.",
    icon: "eye",
  },
  {
    mode: "workspace-write",
    label: "Workspace write",
    description: "Allow workspace edits and confined shell commands.",
    icon: "shield-check",
  },
  {
    mode: "full-access",
    label: "Full access",
    description: "Disable the write sandbox.",
    icon: "shield-off",
  },
];

describe("runtimeModeConfig per-provider overrides", () => {
  it("preserves the classic four runtime modes when providerRuntimeModes is unset", () => {
    expect(resolveCompatibleRuntimeMode("auto", undefined)).toEqual({
      modes: runtimeModeOptions,
      mode: "auto",
    });
    expect(resolveCompatibleRuntimeMode("auto", ["approval-required", "full-access"])).toEqual({
      modes: ["approval-required", "full-access"],
      mode: "approval-required",
    });
  });

  it("uses providerRuntimeModes directly and maps classic modes onto workspace-write fallback", () => {
    expect(
      resolveCompatibleRuntimeMode(
        "auto",
        SPARROW_MODES.map((m) => m.mode),
        SPARROW_MODES,
      ),
    ).toEqual({
      modes: ["read-only", "workspace-write", "full-access"],
      mode: "workspace-write",
    });

    const policy: ManagedPolicySummary = {
      organization: "Acme",
      lockedSettings: [],
      limits: { maxRuntimeMode: "workspace-write" },
    };
    const options = resolveRuntimeModeOptions(
      ["read-only", "workspace-write", "full-access"],
      policy,
      undefined,
      SPARROW_MODES,
    );
    expect(options.map((o) => [o.mode, o.label, o.disabledReason])).toEqual([
      ["read-only", "Read only", undefined],
      ["workspace-write", "Workspace write", undefined],
      ["full-access", "Full access", "Acme limits threads to Workspace write."],
    ]);
  });
});
