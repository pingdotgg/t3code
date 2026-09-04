import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveAgentAwarenessPlatformPresentation,
  resolveAutoSettleReferenceEnvironmentId,
} from "./SettingsRouteScreen.logic";

describe("resolveAutoSettleReferenceEnvironmentId", () => {
  const firstId = EnvironmentId.make("first");
  const secondId = EnvironmentId.make("second");

  it("waits for an earlier grant before exposing a later writable reference", () => {
    const second = { environmentId: secondId, canWriteSettings: true };
    expect(
      resolveAutoSettleReferenceEnvironmentId([
        { environmentId: firstId, canWriteSettings: null },
        second,
      ]),
    ).toBeNull();
    expect(
      resolveAutoSettleReferenceEnvironmentId([
        { environmentId: firstId, canWriteSettings: false },
        second,
      ]),
    ).toBe(secondId);
    expect(
      resolveAutoSettleReferenceEnvironmentId([
        { environmentId: firstId, canWriteSettings: true },
        second,
      ]),
    ).toBe(firstId);
  });

  it("does not wait for later grants after finding the first writable reference", () => {
    expect(
      resolveAutoSettleReferenceEnvironmentId([
        { environmentId: firstId, canWriteSettings: true },
        { environmentId: secondId, canWriteSettings: null },
      ]),
    ).toBe(firstId);
  });

  it("waits before showing a read-only fallback until all grants are resolved", () => {
    expect(
      resolveAutoSettleReferenceEnvironmentId([
        { environmentId: firstId, canWriteSettings: false },
        { environmentId: secondId, canWriteSettings: null },
      ]),
    ).toBeNull();
    expect(
      resolveAutoSettleReferenceEnvironmentId([
        { environmentId: firstId, canWriteSettings: false },
        { environmentId: secondId, canWriteSettings: false },
      ]),
    ).toBe(firstId);
  });

  it("has no reference when no environment supports synchronization", () => {
    expect(resolveAutoSettleReferenceEnvironmentId([])).toBeNull();
  });
});

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("explains that agent awareness settings are unavailable on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: false,
      subtitle: "iOS only",
    });
  });

  it("leaves supported iOS settings unchanged", () => {
    expect(resolveAgentAwarenessPlatformPresentation("ios")).toEqual({
      supported: true,
      subtitle: undefined,
    });
  });
});
