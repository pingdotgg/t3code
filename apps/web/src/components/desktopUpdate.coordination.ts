import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { ServerUpdateTarget } from "@t3tools/client-runtime/state/server";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

export interface CoordinatedUpdateEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: {
    readonly phase: EnvironmentConnectionPhase;
  };
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
}

export interface RemoteServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly targetVersion: string;
}

export function collectRemoteServerUpdateTargets(
  environments: ReadonlyArray<CoordinatedUpdateEnvironment>,
  targetVersion: string | null,
): ReadonlyArray<RemoteServerUpdateTarget> {
  if (targetVersion === null) return [];

  return environments.flatMap((environment) => {
    const descriptor = environment.serverConfig?.environment;
    const capability = descriptor?.capabilities.serverSelfUpdate;
    if (
      environment.connection.phase !== "connected" ||
      descriptor === undefined ||
      descriptor.serverVersion === targetVersion ||
      (capability !== "boot-service" && capability !== "respawn")
    ) {
      return [];
    }

    return [
      {
        environmentId: environment.environmentId,
        serverLabel: `${environment.label} server`,
        targetVersion,
      },
    ];
  });
}

export async function updateRemoteServersConcurrently<A, E>(
  targets: ReadonlyArray<RemoteServerUpdateTarget>,
  updateServer: (target: ServerUpdateTarget) => Promise<AtomCommandResult<A, E>>,
): Promise<
  ReadonlyArray<{
    readonly target: RemoteServerUpdateTarget;
    readonly result: AtomCommandResult<A, E>;
  }>
> {
  return Promise.all(
    targets.map(async (target) => ({
      target,
      result: await updateServer({
        environmentId: target.environmentId,
        input: { targetVersion: target.targetVersion },
      }),
    })),
  );
}

export async function coordinateDesktopUpdateInstall<A, E, DesktopResult>(input: {
  readonly targets: ReadonlyArray<RemoteServerUpdateTarget>;
  readonly updateServer: (target: ServerUpdateTarget) => Promise<AtomCommandResult<A, E>>;
  readonly installDesktop: () => Promise<DesktopResult>;
}): Promise<
  | {
      readonly _tag: "RemoteUpdateFailed";
      readonly failure: {
        readonly target: RemoteServerUpdateTarget;
        readonly result: Extract<AtomCommandResult<A, E>, { readonly _tag: "Failure" }>;
      };
    }
  | { readonly _tag: "DesktopInstallStarted"; readonly result: DesktopResult }
> {
  const updates = await updateRemoteServersConcurrently(input.targets, input.updateServer);
  const failure = updates.find(({ result }) => result._tag === "Failure");
  if (failure?.result._tag === "Failure") {
    return {
      _tag: "RemoteUpdateFailed",
      failure: { target: failure.target, result: failure.result },
    };
  }
  return { _tag: "DesktopInstallStarted", result: await input.installDesktop() };
}
