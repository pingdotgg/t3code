import type { DesktopUpdateChannel } from "@t3tools/contracts";
import { resolveRemoteT3CliPackageSpec } from "@t3tools/ssh/command";

/** Keep the embedded server/runtime version independent from 2code's updater version. */
export function resolveDesktopRemoteCliPackage(input: {
  readonly appVersion: string;
  readonly runtimeVersion: string;
  readonly updateChannel: DesktopUpdateChannel;
  readonly isDevelopment: boolean;
}): string {
  return resolveRemoteT3CliPackageSpec({
    appVersion: input.runtimeVersion,
    updateChannel: input.updateChannel,
    isDevelopment: input.isDevelopment,
  });
}
