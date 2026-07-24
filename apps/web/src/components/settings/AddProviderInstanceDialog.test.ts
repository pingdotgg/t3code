import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";

import {
  createHermesProviderInstanceId,
  isHermesInstanceRemovedError,
  isOwnedHermesEnrollmentRetry,
  resolveWizardNavigation,
  validateProviderInstanceIdForWizard,
} from "./AddProviderInstanceDialog.logic";

describe("Hermes provider instance identity", () => {
  it("keeps the readable label prefix while adding a stable random suffix", () => {
    expect(
      createHermesProviderInstanceId("Research Team", () => "019f99cc-30d4-72c4-b3dd-2ee59cecb856"),
    ).toBe("hermes-research-team-019f99cc30d4");
  });

  it("never reuses an ID when a later dialog uses the same label", () => {
    expect(
      createHermesProviderInstanceId("Research", () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
    ).not.toBe(
      createHermesProviderInstanceId("Research", () => "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
    );
  });

  it("stays within the provider instance ID length limit for long labels", () => {
    const instanceId = createHermesProviderInstanceId(
      "A very long research Hermes display name that should be truncated before persistence",
      () => "019f99cc-30d4-72c4-b3dd-2ee59cecb856",
    );

    expect(instanceId.length).toBeLessThanOrEqual(64);
    expect(instanceId).toMatch(/^hermes-[a-z0-9-]+-[a-z0-9]{12}$/u);
  });

  it("recognizes a server tombstone rejection so the dialog can rotate its nonce", () => {
    expect(isHermesInstanceRemovedError({ code: "instance-removed" })).toBe(true);
    expect(isHermesInstanceRemovedError({ code: "nickname-conflict" })).toBe(false);
    expect(isHermesInstanceRemovedError(new Error("instance removed"))).toBe(false);
  });
});

describe("resolveWizardNavigation", () => {
  const invalidId = { instanceIdError: "Instance ID is required." };
  const validId = { instanceIdError: null };

  it("allows moving from Driver to Identity before the instance id is valid", () => {
    expect(resolveWizardNavigation(0, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
  });

  it("blocks Next from Identity to Config while the instance id is invalid", () => {
    expect(resolveWizardNavigation(1, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("stops a direct Driver-to-Config skip at Identity and surfaces its error", () => {
    expect(resolveWizardNavigation(0, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("allows advancing and skipping forward once the instance id is valid", () => {
    expect(resolveWizardNavigation(1, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
  });

  it("always preserves backward Driver and Identity navigation", () => {
    expect(resolveWizardNavigation(2, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
    expect(resolveWizardNavigation(2, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
    expect(resolveWizardNavigation(1, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });

  it("clamps requested steps to the wizard bounds", () => {
    expect(resolveWizardNavigation(2, 8, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, -1, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });
});

describe("Hermes enrollment retry ownership", () => {
  const existingIds = new Set(["hermes-research", "hermes-existing"]);

  it("allows retrying enrollment for the exact Hermes instance created by this wizard", () => {
    expect(
      isOwnedHermesEnrollmentRetry({
        driver: ProviderDriverKind.make("hermes"),
        instanceId: "hermes-research",
        createdHermesInstanceId: "hermes-research",
      }),
    ).toBe(true);
    expect(
      validateProviderInstanceIdForWizard({
        driver: ProviderDriverKind.make("hermes"),
        instanceId: "hermes-research",
        existingIds,
        createdHermesInstanceId: "hermes-research",
      }),
    ).toBeNull();
  });

  it("still rejects arbitrary existing instances and non-Hermes reuse", () => {
    expect(
      validateProviderInstanceIdForWizard({
        driver: ProviderDriverKind.make("hermes"),
        instanceId: "hermes-existing",
        existingIds,
        createdHermesInstanceId: "hermes-research",
      }),
    ).toContain("already exists");
    expect(
      validateProviderInstanceIdForWizard({
        driver: ProviderDriverKind.make("codex"),
        instanceId: "hermes-research",
        existingIds,
        createdHermesInstanceId: "hermes-research",
      }),
    ).toContain("already exists");
    expect(
      validateProviderInstanceIdForWizard({
        driver: ProviderDriverKind.make("hermes"),
        instanceId: "hermes-research",
        existingIds,
        createdHermesInstanceId: null,
      }),
    ).toContain("already exists");
  });
});
