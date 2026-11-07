import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import {
  homebrewOwnershipFromCommandPath,
  isMiseCommandPath,
  isMiseWrapperScript,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  resolveHomebrewProviderMaintenance,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { FX_DRIVER_KIND } from "./acpSupport.ts";

/** The stable release `fx upgrade` and fx's setup script install. */
const FX_LATEST_RELEASE_URL = "https://releases.fx.sh/latest.txt";

export const fetchLatestFxVersion = Effect.fn("fetchLatestFxVersion")(function* () {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(HttpClientRequest.get(FX_LATEST_RELEASE_URL)).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300 ? response.text : Effect.succeed(""),
    ),
    Effect.map((body) => body.trim().match(/^v?(\d+\.\d+\.\d+)$/)?.[1] ?? null),
    Effect.timeout(4_000),
    Effect.orElseSucceed(() => null),
  );
});

// fx after 0.0.13 needs Darwin 24, but its updater does not check the host version.
export const makeFxMaintenance = (
  lookupLatestVersion: Effect.Effect<string | null>,
): ProviderMaintenanceCapabilitiesResolver => ({
  resolve: Effect.fn("FxMaintenance.resolve")(function* (context) {
    const input = { provider: FX_DRIVER_KIND, packageName: null };
    const manualOnly = makeManualOnlyProviderMaintenanceCapabilities(input);
    if (
      context === null ||
      (context.platform === "darwin" && Number.parseInt(yield* HostProcess.KernelRelease, 10) < 24)
    ) {
      return manualOnly;
    }
    if (
      isMiseCommandPath(context.resolvedCommandPath, context.env) ||
      isMiseCommandPath(context.realCommandPath, context.env) ||
      (yield* isMiseWrapperScript(context))
    ) {
      return makeManualOnlyProviderMaintenanceCapabilities({
        ...input,
        installPath: context.realCommandPath,
        lookupLatestVersion,
      });
    }
    const homebrew = homebrewOwnershipFromCommandPath(context.realCommandPath);
    if (homebrew) {
      if (homebrew.kind !== "formula" || homebrew.name !== "fx-agent") return manualOnly;
      return (yield* resolveHomebrewProviderMaintenance(input, homebrew, context)) ?? manualOnly;
    }
    return makeProviderMaintenanceCapabilities({
      ...input,
      updateExecutable: context.resolvedCommandPath,
      updateArgs: ["upgrade"],
      updateLockKey: `fx:${context.realCommandPath}`,
      platform: context.platform,
      env: context.env,
      lookupLatestVersion,
    });
  }),
});
