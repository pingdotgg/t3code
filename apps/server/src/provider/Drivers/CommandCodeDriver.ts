/**
 * CommandCodeDriver — `ProviderDriver` for the Command Code CLI.
 *
 * Command Code runs as one `-p` subprocess per turn with its own durable
 * headless sessions, so this driver is deliberately lean: no shadow homes,
 * no installer maintenance (the CLI self-updates on launch), and no model
 * catalog of our own — the snapshot advertises whatever `--list-models`
 * reports for the local install, and model slugs are passed straight to
 * `--model`.
 *
 * @module provider/Drivers/CommandCodeDriver
 */
import { CommandCodeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeCommandCodeTextGeneration } from "../../textGeneration/CommandCodeTextGeneration.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { makeCommandCodeSnapshotShape } from "../CommandCodeProvider.ts";
import { makeCommandCodeAdapter } from "../Layers/CommandCodeAdapter.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("commandCode");
const decodeCommandCodeSettings = Schema.decodeSync(CommandCodeSettings);

export type CommandCodeDriverEnv = ChildProcessSpawner.ChildProcessSpawner;

export const CommandCodeDriver: ProviderDriver<CommandCodeSettings, CommandCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Command Code",
    // A single shared ~/.commandcode home: no per-account shadow homes in v1.
    supportsMultipleInstances: false,
  },
  configSchema: CommandCodeSettings,
  defaultConfig: (): CommandCodeSettings => decodeCommandCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const effectiveConfig: CommandCodeSettings = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      };
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stamp = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      const snapshot = yield* makeCommandCodeSnapshotShape({
        config: effectiveConfig,
        env: processEnv,
        stamp,
        displayName: "Command Code",
        driverKind: DRIVER_KIND,
      });
      const adapter = yield* makeCommandCodeAdapter(effectiveConfig, {
        driverKind: DRIVER_KIND,
        instanceId,
        environment: processEnv,
      });
      const textGeneration = makeCommandCodeTextGeneration(effectiveConfig);

      // Probe the CLI once at startup so the UI settles on real status fast.
      yield* Effect.forkScoped(snapshot.refresh.pipe(Effect.ignoreCause({ log: true })));

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
