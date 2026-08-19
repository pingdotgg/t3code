import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getEnvironmentUsageLoadingState,
  isEnvironmentUsageStillReporting,
  resolveEnvironmentUsageScope,
  type EnvironmentUsageOption,
} from "./usageEnvironmentScope";

const environment = (
  environmentId: string,
  phase: EnvironmentConnectionPhase,
): EnvironmentUsageOption => ({
  environmentId: environmentId as EnvironmentId,
  label: environmentId,
  phase,
});

describe("usage environment scope", () => {
  it("keeps healthy and offline environments in all-environment coverage", () => {
    const options = [environment("healthy", "connected"), environment("down", "offline")];
    const scope = resolveEnvironmentUsageScope(options, null);

    expect(scope.environments).toEqual(options);
  });

  it("finishes with healthy totals when another environment is offline", () => {
    expect(
      getEnvironmentUsageLoadingState([
        { phase: "connected", isPending: false, summary: {}, error: null },
        { phase: "offline", isPending: false, summary: null, error: null },
      ]),
    ).toEqual({ isPending: false, isPartial: false });
  });

  it("returns immediately when the only environment is offline", () => {
    expect(
      getEnvironmentUsageLoadingState([
        { phase: "offline", isPending: false, summary: null, error: null },
      ]),
    ).toEqual({ isPending: false, isPartial: false });
  });

  it("keeps healthy totals visible while another environment reconnects", () => {
    expect(
      getEnvironmentUsageLoadingState([
        { phase: "connected", isPending: false, summary: {}, error: null },
        { phase: "reconnecting", isPending: false, summary: null, error: null },
      ]),
    ).toEqual({ isPending: false, isPartial: false });
  });

  it("does not wait indefinitely for a reconnecting environment", () => {
    expect(
      getEnvironmentUsageLoadingState([
        { phase: "reconnecting", isPending: false, summary: null, error: null },
      ]),
    ).toEqual({ isPending: false, isPartial: false });
  });

  it("uses the same reporting state for loading and device progress", () => {
    expect(
      isEnvironmentUsageStillReporting({
        phase: "connected",
        isPending: true,
        summary: null,
        error: null,
      }),
    ).toBe(true);
    expect(
      isEnvironmentUsageStillReporting({
        phase: "connected",
        isPending: false,
        summary: null,
        error: "failed",
      }),
    ).toBe(false);
  });

  it("keeps an initial available connection pending until its state resolves", () => {
    expect(
      getEnvironmentUsageLoadingState([
        { phase: "available", isPending: true, summary: null, error: null },
      ]),
    ).toEqual({ isPending: true, isPartial: false });
  });

  it("keeps the first connection attempt pending", () => {
    expect(
      getEnvironmentUsageLoadingState([
        { phase: "connecting", isPending: true, summary: null, error: null },
      ]),
    ).toEqual({ isPending: true, isPartial: false });
  });

  it("keeps a selected offline environment terminal and isolated", () => {
    const scope = resolveEnvironmentUsageScope(
      [environment("healthy", "connected"), environment("down", "offline")],
      "down" as EnvironmentId,
    );

    expect(scope.selectedEnvironmentId).toBe("down");
    expect(scope.environments).toEqual([environment("down", "offline")]);
  });

  it("falls back to all environments when the selection disappears", () => {
    const options = [environment("healthy", "connected")];
    const scope = resolveEnvironmentUsageScope(options, "removed" as EnvironmentId);

    expect(scope.selectedEnvironmentId).toBeNull();
    expect(scope.environments).toEqual(options);
  });
});
