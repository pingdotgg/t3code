import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
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

/**
 * `fx upgrade` replaces the executable it runs from, so the update runs the
 * instance's resolved binary, wherever `binaryPath` points.
 */
export const makeFxMaintenance = (
  lookupLatestVersion: Effect.Effect<string | null>,
): ProviderMaintenanceCapabilitiesResolver => ({
  resolve: (context) =>
    Effect.succeed(
      context === null
        ? makeManualOnlyProviderMaintenanceCapabilities({
            provider: FX_DRIVER_KIND,
            packageName: null,
          })
        : makeProviderMaintenanceCapabilities({
            provider: FX_DRIVER_KIND,
            packageName: null,
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["upgrade"],
            updateLockKey: `fx:${context.realCommandPath}`,
            platform: context.platform,
            env: context.env,
            lookupLatestVersion,
          }),
    ),
});
