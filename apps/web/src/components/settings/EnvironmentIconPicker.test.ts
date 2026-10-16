import { ENVIRONMENT_MACHINE_KINDS, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ENVIRONMENT_ICON_GROUPS,
  resolveEnvironmentIconGroups,
  resolveEnvironmentIconPickerLock,
} from "./EnvironmentIconPicker";

const config = { environment: { capabilities: {} } } as unknown as ServerConfig;

describe("resolveEnvironmentIconPickerLock", () => {
  it("waits for a settings grant before allowing changes", () => {
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config, operateAccess: "pending" }),
    ).toMatch(/cannot change/);
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config, operateAccess: "granted" }),
    ).toBeNull();
  });
});

describe("resolveEnvironmentIconGroups", () => {
  const kindsOf = (groups: ReadonlyArray<{ readonly kinds: ReadonlyArray<string> }>) =>
    groups.flatMap((group) => group.kinds);

  it("files every machine kind under exactly one section", () => {
    const listed = kindsOf(ENVIRONMENT_ICON_GROUPS);
    expect(listed.toSorted()).toEqual([...ENVIRONMENT_MACHINE_KINDS].toSorted());
  });

  it("offers older servers only the kinds they can store", () => {
    expect(kindsOf(resolveEnvironmentIconGroups(config))).toEqual([
      "server",
      "cloud",
      "desktop",
      "laptop",
      "mac-mini",
      "mac-studio",
      "linux",
    ]);
  });

  it("offers the kinds the server advertises", () => {
    const serverConfig = {
      environment: {
        capabilities: { environmentIcon: true, environmentIconKinds: ["server", "ubuntu"] },
      },
    } as unknown as ServerConfig;
    expect(resolveEnvironmentIconGroups(serverConfig)).toEqual([
      { label: "Machines", kinds: ["server"] },
      { label: "Linux distributions", kinds: ["ubuntu"] },
    ]);
  });
});
