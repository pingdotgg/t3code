import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  collectRemoteServerUpdateTargets,
  coordinateDesktopUpdateInstall,
  updateRemoteServersConcurrently,
  type CoordinatedUpdateEnvironment,
} from "./desktopUpdate.coordination";

function environment(input: {
  readonly id: string;
  readonly label: string;
  readonly phase?: CoordinatedUpdateEnvironment["connection"]["phase"];
  readonly serverVersion?: string;
  readonly selfUpdate?: NonNullable<
    ServerConfig["environment"]["capabilities"]["serverSelfUpdate"]
  >;
}): CoordinatedUpdateEnvironment {
  const capabilities = input.selfUpdate === undefined ? {} : { serverSelfUpdate: input.selfUpdate };
  return {
    environmentId: input.id as EnvironmentId,
    label: input.label,
    connection: { phase: input.phase ?? "connected" },
    serverConfig: {
      environment: {
        serverVersion: input.serverVersion ?? "1.0.0",
        capabilities,
      },
    } as ServerConfig,
  };
}

describe("desktop update coordination", () => {
  it("selects every connected self-updatable remote that has not reached the desktop target", () => {
    const targets = collectRemoteServerUpdateTargets(
      [
        environment({ id: "will", label: "Will", selfUpdate: "boot-service" }),
        environment({ id: "m1", label: "M1", selfUpdate: "respawn" }),
        environment({
          id: "current",
          label: "Current",
          selfUpdate: "boot-service",
          serverVersion: "1.1.0",
        }),
        environment({
          id: "offline",
          label: "Offline",
          selfUpdate: "boot-service",
          phase: "offline",
        }),
        environment({ id: "desktop", label: "Desktop", selfUpdate: "desktop-managed" }),
        environment({ id: "manual", label: "Manual" }),
      ],
      "1.1.0",
    );

    expect(targets).toEqual([
      {
        environmentId: "will",
        serverLabel: "Will server",
        targetVersion: "1.1.0",
      },
      {
        environmentId: "m1",
        serverLabel: "M1 server",
        targetVersion: "1.1.0",
      },
    ]);
  });

  it("starts all remote cutovers before waiting for any one environment to reconnect", async () => {
    let finishWill: (() => void) | undefined;
    let finishM1: (() => void) | undefined;
    const updateServer = vi.fn(
      ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
        new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
          const finish = () => resolve(AsyncResult.success(undefined));
          if (environmentId === "will") finishWill = finish;
          if (environmentId === "m1") finishM1 = finish;
        }),
    );
    const targets = [
      {
        environmentId: "will" as EnvironmentId,
        serverLabel: "Will server",
        targetVersion: "1.1.0",
      },
      { environmentId: "m1" as EnvironmentId, serverLabel: "M1 server", targetVersion: "1.1.0" },
    ];

    const updates = updateRemoteServersConcurrently(targets, updateServer);

    expect(updateServer).toHaveBeenCalledTimes(2);
    expect(updateServer).toHaveBeenNthCalledWith(1, {
      environmentId: "will",
      input: { targetVersion: "1.1.0" },
    });
    expect(updateServer).toHaveBeenNthCalledWith(2, {
      environmentId: "m1",
      input: { targetVersion: "1.1.0" },
    });

    finishWill?.();
    await Promise.resolve();
    let completed = false;
    void updates.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    finishM1?.();
    await expect(updates).resolves.toMatchObject([
      { target: targets[0], result: { _tag: "Success" } },
      { target: targets[1], result: { _tag: "Success" } },
    ]);
  });

  it("does not install the desktop update when a remote server fails to converge", async () => {
    const targets = [
      {
        environmentId: "will" as EnvironmentId,
        serverLabel: "Will server",
        targetVersion: "1.1.0",
      },
      {
        environmentId: "m1" as EnvironmentId,
        serverLabel: "M1 server",
        targetVersion: "1.1.0",
      },
    ];
    const updateServer = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.success(undefined))
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("rollback"))));
    const installDesktop = vi.fn();

    const result = await coordinateDesktopUpdateInstall({
      targets,
      updateServer,
      installDesktop,
    });

    expect(result).toMatchObject({
      _tag: "RemoteUpdateFailed",
      failure: { target: targets[1], result: { _tag: "Failure" } },
    });
    expect(installDesktop).not.toHaveBeenCalled();
  });

  it("starts the desktop install after every remote server converges", async () => {
    const targets = [
      {
        environmentId: "will" as EnvironmentId,
        serverLabel: "Will server",
        targetVersion: "1.1.0",
      },
      {
        environmentId: "m1" as EnvironmentId,
        serverLabel: "M1 server",
        targetVersion: "1.1.0",
      },
    ];
    const updateServer = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const installDesktop = vi.fn().mockResolvedValue("accepted");

    const result = await coordinateDesktopUpdateInstall({
      targets,
      updateServer,
      installDesktop,
    });

    expect(updateServer).toHaveBeenCalledTimes(2);
    expect(installDesktop).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ _tag: "DesktopInstallStarted", result: "accepted" });
  });
});
