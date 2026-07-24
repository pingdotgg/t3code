import type {
  DesktopBridge,
  DesktopWslState,
  EnvironmentId,
  LocalServerAdvertisement,
} from "@t3tools/contracts";

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

export interface LocalServerPairingCandidate {
  readonly advertisement: LocalServerAdvertisement;
  readonly pairAgain: boolean;
}

export function selectLocalServerPairingCandidates(
  advertisements: ReadonlyArray<LocalServerAdvertisement>,
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connection: { readonly phase: string };
  }>,
): ReadonlyArray<LocalServerPairingCandidate> {
  return advertisements.flatMap((advertisement) => {
    const savedEnvironment = environments.find(
      (environment) => environment.environmentId === advertisement.environmentId,
    );
    if (savedEnvironment && savedEnvironment.connection.phase !== "error") {
      return [];
    }
    return [
      {
        advertisement,
        pairAgain: savedEnvironment !== undefined,
      },
    ];
  });
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}
