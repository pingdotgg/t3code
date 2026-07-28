import { assert, describe, it } from "@effect/vitest";

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
      },
    );
  });

  it("accepts a separate flag value", () => {
    assert.equal(
      DesktopBackendMode.parseDesktopBackendModeOverride(["electron", "--backend-mode", "managed"]),
      "managed",
    );
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
