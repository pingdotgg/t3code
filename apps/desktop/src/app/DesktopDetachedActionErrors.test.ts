import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";

import { DesktopLifecycleRelaunchError } from "./DesktopLifecycle.ts";
import { DesktopApplicationMenuActionError } from "../window/DesktopApplicationMenu.ts";

describe("desktop detached action errors", () => {
  it("preserves the complete relaunch failure cause and reason", () => {
    const cause = Cause.combine(
      Cause.fail(new Error("shutdown failed")),
      Cause.die(new Error("relaunch defect")),
    );
    const error = new DesktopLifecycleRelaunchError({
      reason: "apply update",
      cause,
    });

    assert.strictEqual(error.cause, cause);
    assert.equal(error.reason, "apply update");
    assert.equal(error.message, 'Desktop relaunch failed for reason "apply update".');
  });

  it("preserves the complete menu action failure cause and action", () => {
    const cause = Cause.combine(
      Cause.fail(new Error("window unavailable")),
      Cause.die(new Error("dispatch defect")),
    );
    const error = new DesktopApplicationMenuActionError({
      action: "open-settings",
      cause,
    });

    assert.strictEqual(error.cause, cause);
    assert.equal(error.action, "open-settings");
    assert.equal(error.message, 'Desktop menu action "open-settings" failed.');
  });
});
