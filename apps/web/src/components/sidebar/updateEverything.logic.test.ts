import { EnvironmentId, type ServerSelfUpdateCapability } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectServerUpdateTargets,
  describeUpdateEverything,
  runUpdateEverything,
  type UpdateEverythingMachine,
} from "./updateEverything.logic";

function machine(
  id: string,
  serverVersion: string,
  selfUpdate: ServerSelfUpdateCapability | undefined,
  overrides: Partial<UpdateEverythingMachine> = {},
): UpdateEverythingMachine {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion,
        capabilities: {
          repositoryIdentity: true,
          ...(selfUpdate ? { serverSelfUpdate: selfUpdate } : {}),
          ...(selfUpdate === "desktop-managed" ? { desktopAppUpdate: true } : {}),
        },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    },
    connected: true,
    hostedByThisApp: false,
    canMaintain: true,
    updateState: { status: "idle" },
    ...overrides,
  };
}

describe("collectServerUpdateTargets", () => {
  it("updates only remote servers that can move to the target on their channel", () => {
    const targets = collectServerUpdateTargets(
      [
        machine("this-app", "0.0.40", "desktop-managed", { hostedByThisApp: true }),
        machine("service", "0.0.40", "boot-service"),
        machine("nightly-service", "0.0.49-nightly.20261001.3", "boot-service"),
        machine("other-desktop", "0.0.49-nightly.20261001.3", "desktop-managed"),
        machine("offline", "0.0.40", "boot-service", { connected: false }),
        machine("no-scope", "0.0.40", "boot-service", { canMaintain: false }),
        machine("current", "0.0.50", "boot-service"),
        machine("manual", "0.0.40", undefined),
      ],
      "0.0.50",
    );

    expect(targets.map((target) => [target.serverLabel, target.targetVersion])).toEqual([
      ["service", "0.0.50"],
      ["other-desktop", "0.0.50"],
    ]);
  });
});

describe("runUpdateEverything", () => {
  it("restarts servers after providers finish and installs this app last", async () => {
    const calls: string[] = [];
    let finishProviders = () => {};
    const run = runUpdateEverything({
      downloadLocal: async () => {
        calls.push("download");
        return true;
      },
      updateProviders: () =>
        new Promise<void>((resolve) => {
          calls.push("providers");
          finishProviders = resolve;
        }),
      updateServers: async () => {
        calls.push("servers");
      },
      installLocal: async () => {
        calls.push("install");
      },
    });

    await Promise.resolve();
    expect(calls).toEqual(["download", "providers"]);
    finishProviders();
    await run;
    expect(calls).toEqual(["download", "providers", "servers", "install"]);
  });

  it("still updates remote machines when the local download fails", async () => {
    const calls: string[] = [];
    await runUpdateEverything({
      downloadLocal: async () => false,
      updateProviders: async () => {
        calls.push("providers");
      },
      updateServers: async () => {
        calls.push("servers");
      },
      installLocal: async () => {
        calls.push("install");
      },
    });

    expect(calls).toEqual(["providers", "servers"]);
  });
});

describe("describeUpdateEverything", () => {
  it("summarizes the run and lists each machine once", () => {
    const alvin = EnvironmentId.make("alvin");
    expect(
      describeUpdateEverything({
        localVersion: "0.0.50",
        servers: [
          {
            environmentId: alvin,
            serverLabel: "alvin",
            selfUpdate: "boot-service",
            targetVersion: "0.0.50",
          },
          {
            environmentId: EnvironmentId.make("studio"),
            serverLabel: "studio",
            selfUpdate: "desktop-managed",
            targetVersion: "0.0.50",
          },
        ],
        providerMachines: [
          { environmentId: alvin, label: "alvin", providers: ["Codex", "Claude"] },
          { environmentId: EnvironmentId.make("box"), label: "box", providers: ["Cursor"] },
        ],
      }),
    ).toEqual({
      summary: "Update this app, 2 servers, and 3 providers",
      lines: [
        "This app: 0.0.50, restarts last",
        "alvin: server to 0.0.50, Codex, Claude",
        "studio: desktop app update",
        "box: Cursor",
      ],
    });
  });

  it("reads naturally with one kind of update", () => {
    expect(
      describeUpdateEverything({
        localVersion: null,
        servers: [],
        providerMachines: [
          { environmentId: EnvironmentId.make("alvin"), label: "alvin", providers: ["Codex"] },
        ],
      }).summary,
    ).toBe("Update 1 provider");
  });
});
