import { describe, expect, it } from "vite-plus/test";

import {
  activationSwitchPresentation,
  reconcilePendingActivation,
  settlePendingActivation,
  type PendingActivation,
} from "./environmentActivationSwitchState";

describe("environment activation switch state", () => {
  const request: PendingActivation = { previous: false, requested: true };

  it("keeps a successful request optimistic until the catalog catches up", () => {
    const settled = settlePendingActivation(request, request, true);

    expect(activationSwitchPresentation(false, settled)).toEqual({
      disabled: true,
      value: true,
    });
    expect(reconcilePendingActivation(settled, false)).toBe(request);
    expect(reconcilePendingActivation(settled, true)).toBeNull();
  });

  it("rolls back a failed request immediately", () => {
    const settled = settlePendingActivation(request, request, false);

    expect(settled).toBeNull();
    expect(activationSwitchPresentation(false, settled)).toEqual({
      disabled: false,
      value: false,
    });
  });

  it("does not let an older completion clear a newer request", () => {
    const newerRequest: PendingActivation = { previous: true, requested: false };

    expect(settlePendingActivation(newerRequest, request, false)).toBe(
      newerRequest,
    );
  });
});
