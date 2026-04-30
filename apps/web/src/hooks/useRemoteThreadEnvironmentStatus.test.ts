import { describe, expect, it } from "vitest";
import {
  isRemoteEnvironmentDisconnected,
  resolveRemoteThreadTooltip,
} from "./useRemoteThreadEnvironmentStatus";

describe("isRemoteEnvironmentDisconnected", () => {
  it("returns true when every remote environment is disconnected", () => {
    expect(isRemoteEnvironmentDisconnected(["disconnected", "error"])).toBe(true);
  });

  it("returns false when any remote environment is still connected", () => {
    expect(isRemoteEnvironmentDisconnected(["disconnected", "connected"])).toBe(false);
  });

  it("returns false while a remote environment is still connecting", () => {
    expect(isRemoteEnvironmentDisconnected(["connecting"])).toBe(false);
  });
});

describe("resolveRemoteThreadTooltip", () => {
  it("uses the connected tooltip wording when a label is available", () => {
    expect(
      resolveRemoteThreadTooltip({
        environmentLabel: "Remote devbox",
        isDisconnected: false,
      }),
    ).toBe("Remote environment: Remote devbox");
  });

  it("uses the disconnected tooltip wording when a label is available", () => {
    expect(
      resolveRemoteThreadTooltip({
        environmentLabel: "Remote devbox",
        isDisconnected: true,
      }),
    ).toBe("Remote environment disconnected: Remote devbox");
  });

  it("falls back to the base disconnected tooltip when no label is available", () => {
    expect(
      resolveRemoteThreadTooltip({
        environmentLabel: null,
        isDisconnected: true,
      }),
    ).toBe("Remote environment disconnected");
  });
});
