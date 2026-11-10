import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { compareCursorVersions, probeCursorCliAbout, resolveCursorBinaryPath } from "./cli.ts";
import type { CursorSettings } from "../settings.ts";

const DRIVER = ProviderDriverKind.make("cursor");

// cursor-agent updates itself, so the resolved executable is its own updater.
export const cursorMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? {
            ...makeProviderMaintenanceCapabilities({
              provider: DRIVER,
              packageName: null,
              updateExecutable: context.resolvedCommandPath,
              updateArgs: ["update"],
              updateLockKey: "cursor-agent",
              platform: context.platform,
              env: context.env,
            }),
            compareVersions: compareCursorVersions,
          }
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER,
            packageName: null,
          }),
    ),
};

export const enrichCursorSnapshot = Effect.fn("enrichCursorSnapshot")(function* (input: {
  readonly settings: CursorSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const lookupLatestVersion =
    input.enableProviderUpdateChecks === false
      ? undefined
      : probeCursorCliAbout(input.settings, input.environment).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.map((about) => about?.latestVersion ?? null),
        );
  return yield* enrichProviderSnapshotWithVersionAdvisory(
    input.snapshot,
    {
      ...input.maintenanceCapabilities,
      compareVersions: compareCursorVersions,
      ...(lookupLatestVersion ? { latestVersion: null, lookupLatestVersion } : {}),
    },
    { enableProviderUpdateChecks: input.enableProviderUpdateChecks },
  ).pipe(
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Cursor version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
        binaryPath: resolveCursorBinaryPath(input.settings),
      }),
    ),
    Effect.asVoid,
  );
});
