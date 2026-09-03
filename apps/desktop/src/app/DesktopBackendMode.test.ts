import { assert, describe, expect, it } from "@effect/vitest";

import * as DesktopBackendMode from "./DesktopBackendMode.ts";

describe("DesktopBackendMode", () => {
  const captureThrown = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("Expected the operation to throw.");
  };

  it("uses the persisted mode when no CLI override is present", () => {
    assert.deepEqual(DesktopBackendMode.resolveDesktopBackendModeState([], "client-only"), {
      effectiveMode: "client-only",
      configuredMode: "client-only",
      cliOverride: null,
      source: "settings",
    });
  });

  it("gives the CLI override precedence without changing the configured mode", () => {
    assert.deepEqual(
      DesktopBackendMode.resolveDesktopBackendModeState(
        ["electron", "main.cjs", "--backend-mode=client-only"],
        "managed",
      ),
      {
        effectiveMode: "client-only",
        configuredMode: "managed",
        cliOverride: "client-only",
        source: "cli",
      },
    );
  });

  it("accepts a separate flag value", () => {
    assert.equal(
      DesktopBackendMode.parseDesktopBackendModeOverride(["electron", "--backend-mode", "managed"]),
      "managed",
    );
  });

  it("uses client-only for a packaged launch when the userdata server is already running", () => {
    expect(
      DesktopBackendMode.resolveDesktopBackendModeForExistingServer(
        DesktopBackendMode.resolveDesktopBackendModeState([], "managed"),
        { isDevelopment: false, hasRunningUserdataServer: true },
      ),
    ).toEqual({
      effectiveMode: "client-only",
      configuredMode: "managed",
      cliOverride: null,
      source: "existing-server",
    });
  });

  it("keeps managed mode in development and when no userdata server is running", () => {
    const state = DesktopBackendMode.resolveDesktopBackendModeState([], "managed");
    expect(
      DesktopBackendMode.resolveDesktopBackendModeForExistingServer(state, {
        isDevelopment: true,
        hasRunningUserdataServer: true,
      }),
    ).toBe(state);
    expect(
      DesktopBackendMode.resolveDesktopBackendModeForExistingServer(state, {
        isDevelopment: false,
        hasRunningUserdataServer: false,
      }),
    ).toBe(state);
  });

  it.each([
    ["--backend-mode=other", "invalid-value"],
    ["--backend-mode=", "missing-value"],
    ["--backend-mode", "missing-value"],
  ])("rejects invalid launch argument %s", (argument, reason) => {
    const error = captureThrown(() =>
      DesktopBackendMode.parseDesktopBackendModeOverride(["electron", argument]),
    );
    assert.isTrue(DesktopBackendMode.isDesktopBackendModeArgumentError(error));
    if (DesktopBackendMode.isDesktopBackendModeArgumentError(error)) {
      assert.equal(error.reason, reason);
    }
  });

  it("rejects repeated overrides", () => {
    const error = captureThrown(() =>
      DesktopBackendMode.parseDesktopBackendModeOverride([
        "--backend-mode=managed",
        "--backend-mode=client-only",
      ]),
    );
    assert.isTrue(DesktopBackendMode.isDesktopBackendModeArgumentError(error));
    if (DesktopBackendMode.isDesktopBackendModeArgumentError(error)) {
      assert.equal(error.reason, "repeated");
    }
  });
});
