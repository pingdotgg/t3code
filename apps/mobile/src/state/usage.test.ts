import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getEnvironmentUsageLoadingState,
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

describe("mobile usage environment scope", () => {
  it("does not wait indefinitely for a reconnecting environment", () => {
    expect(
      getEnvironmentUsageLoadingState([
        { phase: "reconnecting", isPending: false, summary: null, error: null },
      ]),
    ).toEqual({ isPending: false, isPartial: false });
  });

  it("does not let an offline environment hold healthy totals open", () => {
    expect(
      getEnvironmentUsageLoadingState([
        { phase: "connected", isPending: false, summary: {}, error: null },
        { phase: "offline", isPending: false, summary: null, error: null },
      ]),
    ).toEqual({ isPending: false, isPartial: false });
  });

  it("waits for an initial available connection state", () => {
    expect(
      getEnvironmentUsageLoadingState([
        { phase: "available", isPending: true, summary: null, error: null },
      ]),
    ).toEqual({ isPending: true, isPartial: false });
  });

  it("waits for the first connection attempt", () => {
    expect(
      getEnvironmentUsageLoadingState([
        { phase: "connecting", isPending: true, summary: null, error: null },
      ]),
    ).toEqual({ isPending: true, isPartial: false });
  });

  it("isolates a selected environment and falls back when it disappears", () => {
    const options = [environment("healthy", "connected"), environment("down", "offline")];

    expect(resolveEnvironmentUsageScope(options, "down" as EnvironmentId).environments).toEqual([
      options[1],
    ]);
    expect(
      resolveEnvironmentUsageScope(options.slice(0, 1), "down" as EnvironmentId)
        .selectedEnvironmentId,
    ).toBeNull();
  });
});
