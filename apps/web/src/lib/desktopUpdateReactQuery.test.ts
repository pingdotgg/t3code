import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { DesktopUpdateState } from "@t3tools/contracts";
import {
  desktopUpdateQueryKeys,
  desktopUpdateStateQueryOptions,
  setDesktopUpdateStateQueryData,
} from "./desktopUpdateReactQuery";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktopUpdateStateQueryOptions", () => {
  it("always refetches on mount so Settings does not reuse stale desktop update state", () => {
    const options = desktopUpdateStateQueryOptions();

    expect(options.staleTime).toBe(Infinity);
    expect(options.refetchOnMount).toBe("always");
  });
});

describe("setDesktopUpdateStateQueryData", () => {
  it("writes desktop update state into the shared cache key", () => {
    const queryClient = new QueryClient();
    const nextState: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
    };

    setDesktopUpdateStateQueryData(queryClient, nextState);

    expect(queryClient.getQueryData(desktopUpdateQueryKeys.state())).toEqual(nextState);
  });
});
