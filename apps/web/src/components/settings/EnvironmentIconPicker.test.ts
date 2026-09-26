import type { ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveEnvironmentIconPickerLock } from "./EnvironmentIconPicker";

const config = (environmentIcon: boolean | undefined) =>
  ({
    environment: { capabilities: environmentIcon === undefined ? {} : { environmentIcon } },
  }) as unknown as ServerConfig;

describe("resolveEnvironmentIconPickerLock", () => {
  it("locks until the environment is connected", () => {
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: null, operateAccess: "granted" }),
    ).toMatch(/Connect/);
  });

  it("locks on servers that predate the setting, before looking at permissions", () => {
    expect(
      resolveEnvironmentIconPickerLock({
        serverConfig: config(undefined),
        operateAccess: "denied",
      }),
    ).toMatch(/too old/);
  });

  it("locks when the session cannot operate the environment", () => {
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config(true), operateAccess: "denied" }),
    ).toMatch(/cannot change/);
  });

  it("stays open while access is still resolving so a slow session does not flicker", () => {
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config(true), operateAccess: "pending" }),
    ).toBeNull();
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config(true), operateAccess: "granted" }),
    ).toBeNull();
  });
});
