import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  presentRemoveSavedEnvironment,
  REMOVE_ENVIRONMENT_CONFIRM_TITLE,
  REMOVE_ENVIRONMENT_FAILURE_TITLE,
} from "./remove-environment-confirm";

const OFFLINE_DIRECT_ID = EnvironmentId.make("offline-direct");

/** Confirm, remove, and persist-failure behavior for Settings → Environments trash. */
describe("presentRemoveSavedEnvironment", () => {
  /** Offline rows still get a confirm even without a connected-list label. */
  it("presents a confirm for an offline direct environment even without a list label", () => {
    const presentConfirm = vi.fn();
    const remove = vi.fn();

    presentRemoveSavedEnvironment({
      environmentId: OFFLINE_DIRECT_ID,
      remove,
      presentConfirm,
      presentError: vi.fn(),
    });

    expect(remove).not.toHaveBeenCalled();
    expect(presentConfirm).toHaveBeenCalledOnce();
    expect(presentConfirm.mock.calls[0]?.[0]).toMatchObject({
      title: REMOVE_ENVIRONMENT_CONFIRM_TITLE,
      confirmText: "Remove",
      destructive: true,
      message: expect.stringContaining(OFFLINE_DIRECT_ID),
    });
  });

  /** Confirm runs the catalog remove and does not present an error on success. */
  it("removes the catalog target after confirm", async () => {
    const presentConfirm = vi.fn();
    const presentError = vi.fn();
    const remove = vi.fn(async () => AsyncResult.success(undefined));

    presentRemoveSavedEnvironment({
      environmentId: OFFLINE_DIRECT_ID,
      environmentLabel: "Stale Mac",
      remove,
      presentConfirm,
      presentError,
    });

    await presentConfirm.mock.calls[0]?.[0].onConfirm();

    expect(remove).toHaveBeenCalledWith(OFFLINE_DIRECT_ID);
    expect(presentError).not.toHaveBeenCalled();
  });

  /** Keychain persist failure is shown and the row is not treated as removed. */
  it("surfaces a persist failure and does not treat the row as removed", async () => {
    const presentConfirm = vi.fn();
    const presentError = vi.fn();
    const remove = vi.fn(async () =>
      AsyncResult.failure(
        Cause.fail(new Error("Could not save the local connection catalog: keychain write failed")),
      ),
    );

    presentRemoveSavedEnvironment({
      environmentId: OFFLINE_DIRECT_ID,
      environmentLabel: "Stale Mac",
      remove,
      presentConfirm,
      presentError,
    });

    await presentConfirm.mock.calls[0]?.[0].onConfirm();

    expect(remove).toHaveBeenCalledWith(OFFLINE_DIRECT_ID);
    expect(presentError).toHaveBeenCalledWith(
      REMOVE_ENVIRONMENT_FAILURE_TITLE,
      "Could not save the local connection catalog: keychain write failed",
    );
  });
});
