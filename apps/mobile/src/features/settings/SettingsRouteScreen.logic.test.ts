import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveAutoSettleReferenceEnvironmentId } from "./SettingsRouteScreen.logic";

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
});
