import { type DesktopEnvironmentBootstrap, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createDesktopSecondaryBootstrapsReader } from "./desktopLocal";

describe("desktop local topology reads", () => {
  it("reuses snapshots when polling returns fresh objects for the same topology", () => {
    const secondary: DesktopEnvironmentBootstrap = {
      id: "wsl:default",
      label: "WSL",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
      bootstrapToken: "bootstrap-1",
    };
    let entries = [secondary];
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => entries.map((entry) => ({ ...entry })),
    }));

    const connected = reader.readSnapshot();
    expect(reader.readSnapshot()).toBe(connected);
    expect(reader.readResult()).toEqual({ _tag: "Success", bootstraps: connected });
    expect(reader.readSnapshot()).toBe(connected);

    entries = [];
    const empty = reader.readSnapshot();
    expect(empty).toEqual([]);
    expect(reader.readSnapshot()).toBe(empty);
  });

  it.each<Partial<DesktopEnvironmentBootstrap>>([
    { id: "wsl:Debian" },
    { label: "Renamed backend" },
    { runningDistro: "Debian" },
    { httpBaseUrl: "http://127.0.0.1:4001" },
    { wsBaseUrl: "ws://127.0.0.1:4001" },
    { bootstrapToken: "bootstrap-2" },
  ])("publishes bootstrap changes: %j", (change) => {
    let secondary: DesktopEnvironmentBootstrap = {
      id: "wsl:default",
      label: "WSL",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
      bootstrapToken: "bootstrap-1",
    };
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => [{ ...secondary }],
    }));
    const before = reader.readSnapshot();
    secondary = { ...secondary, ...change };
    const after = reader.readSnapshot();
    expect(after).not.toBe(before);
    expect(after).toEqual([secondary]);
    expect(reader.readSnapshot()).toBe(after);
  });

  it("filters the primary bootstrap from successful topology reads", () => {
    const secondary = {
      id: "wsl:Ubuntu",
      label: "WSL: Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
    };

    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => [
        {
          ...secondary,
          id: PRIMARY_LOCAL_ENVIRONMENT_ID,
          label: "Windows",
        },
        secondary,
      ],
    }));

    expect(reader.readResult()).toEqual({ _tag: "Success", bootstraps: [secondary] });
  });

  it("retains the last successful snapshot only until another read succeeds", () => {
    const secondary = {
      id: "wsl:Ubuntu",
      label: "WSL: Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
    };
    let readBootstraps = () => [secondary];
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => readBootstraps(),
    }));

    const connectedSnapshot = reader.readSnapshot();
    expect(connectedSnapshot).toEqual([secondary]);

    readBootstraps = () => {
      throw new Error("IPC unavailable");
    };
    expect(reader.readSnapshot()).toBe(connectedSnapshot);

    readBootstraps = () => [];
    const removedSnapshot = reader.readSnapshot();
    expect(removedSnapshot).toEqual([]);

    readBootstraps = () => {
      throw new Error("IPC unavailable again");
    };
    expect(reader.readSnapshot()).toBe(removedSnapshot);
  });
});
