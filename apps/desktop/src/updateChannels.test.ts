import { describe, expect, it } from "vitest";

import {
  doesVersionMatchDesktopUpdateChannel,
  isNightlyDesktopVersion,
  resolveDefaultDesktopUpdateChannel,
} from "./updateChannels.ts";

describe("isNightlyDesktopVersion", () => {
  it("detects packaged nightly versions", () => {
    expect(isNightlyDesktopVersion("0.0.17-nightly.20260415.1")).toBe(true);
  });

  it("does not flag stable versions as nightly", () => {
    expect(isNightlyDesktopVersion("0.0.17")).toBe(false);
  });
});

describe("resolveDefaultDesktopUpdateChannel", () => {
  it("defaults stable builds to latest", () => {
    expect(resolveDefaultDesktopUpdateChannel("0.0.17")).toBe("latest");
  });

  it("defaults nightly builds to nightly", () => {
    expect(resolveDefaultDesktopUpdateChannel("0.0.17-nightly.20260415.1")).toBe("nightly");
  });
});

describe("doesVersionMatchDesktopUpdateChannel", () => {
  it("accepts nightly releases on the nightly channel", () => {
    expect(doesVersionMatchDesktopUpdateChannel("0.0.17-nightly.20260416.1", "nightly")).toBe(true);
  });

  it("rejects stable releases on the nightly channel", () => {
    expect(doesVersionMatchDesktopUpdateChannel("0.0.17", "nightly")).toBe(false);
  });

  it("rejects nightly releases on the stable channel", () => {
    expect(doesVersionMatchDesktopUpdateChannel("0.0.17-nightly.20260416.1", "latest")).toBe(false);
  });
});
