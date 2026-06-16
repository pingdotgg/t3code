import { describe, expect, it } from "vite-plus/test";

import { advanceInstanceWizard } from "./AddProviderInstanceDialog";

describe("advanceInstanceWizard", () => {
  it("advances from the Driver step even when the instance id is invalid", () => {
    // The Driver step (index 0) does not own the Instance ID field, so an
    // invalid id must not block leaving it.
    expect(advanceInstanceWizard(0, 3, { instanceIdError: "Instance ID is required." })).toEqual({
      kind: "advance",
      step: 1,
    });
  });

  it("blocks leaving the Identity step while the instance id is invalid", () => {
    // Regression for #2813: clicking Next on the Identity step used to advance
    // unconditionally, so the user reached the final step only for "Add
    // instance" to silently no-op.
    expect(advanceInstanceWizard(1, 3, { instanceIdError: "Instance ID is required." })).toEqual({
      kind: "blocked",
      error: "Instance ID is required.",
    });
  });

  it("advances from the Identity step once the instance id is valid", () => {
    expect(advanceInstanceWizard(1, 3, { instanceIdError: null })).toEqual({
      kind: "advance",
      step: 2,
    });
  });

  it("never advances past the last step", () => {
    expect(advanceInstanceWizard(2, 3, { instanceIdError: null })).toEqual({
      kind: "advance",
      step: 2,
    });
  });
});
