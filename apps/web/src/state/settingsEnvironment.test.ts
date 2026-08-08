import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSettingsEnvironmentId } from "./settingsEnvironment";

const primary = EnvironmentId.make("primary");
const relayA = EnvironmentId.make("relay-a");
const relayB = EnvironmentId.make("relay-b");

describe("resolveSettingsEnvironmentId", () => {
  it("prefers the primary environment when the session has one", () => {
    expect(resolveSettingsEnvironmentId(primary, [relayA, primary])).toBe(primary);
  });

  it("falls back to a connected device when no primary connection exists", () => {
    // The hosted app has no PrimaryConnectionTarget; without this fallback the
    // settings panels read schema defaults and drop every write.
    expect(resolveSettingsEnvironmentId(null, [relayA, relayB])).toBe(relayA);
  });

  it("returns null before the catalog hydrates", () => {
    expect(resolveSettingsEnvironmentId(null, [])).toBeNull();
  });
});
