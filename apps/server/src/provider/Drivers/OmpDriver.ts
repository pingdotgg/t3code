import {
  OmpSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const DRIVER_KIND = ProviderDriverKind.make("omp");
const decodeSettings = Schema.decodeSync(OmpSettings);
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

export type OmpDriverEnv = ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto;

const textGeneration: TextGeneration.TextGeneration["Service"] = {
  generateCommitMessage: () => Effect.fail(new TextGenerationError({ operation: "generateCommitMessage", detail: "omp text generation is not implemented yet." })),
  generatePrContent: () => Effect.fail(new TextGenerationError({ operation: "generatePrContent", detail: "omp text generation is not implemented yet." })),
  generateBranchName: () => Effect.fail(new TextGenerationError({ operation: "generateBranchName", detail: "omp text generation is not implemented yet." })),
  generateThreadTitle: () => Effect.fail(new TextGenerationError({ operation: "generateThreadTitle", detail: "omp text generation is not implemented yet." })),
};

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "oh-my-pi", supportsMultipleInstances: true },
  configSchema: OmpSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const continuation = { driverKind: DRIVER_KIND, continuationKey: `${DRIVER_KIND}:instance:${instanceId}` };
      const stamp = withInstanceIdentity({ instanceId, driverKind: DRIVER_KIND, displayName, accentColor, continuationGroupKey: continuation.continuationKey });
      const settings = { ...config, enabled } satisfies OmpSettings;
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const snapshot: ServerProvider = stamp({
        displayName: "oh-my-pi",
        enabled: settings.enabled,
        installed: true,
        version: null,
        status: settings.enabled ? "warning" : "disabled",
        auth: { status: "unknown" },
        checkedAt,
        models: [
          { slug: "nine/cate.primary", name: "Omni Primary", isCustom: false, capabilities: EMPTY_CAPABILITIES },
          { slug: "nine/cate.premium", name: "Omni Premium", isCustom: false, capabilities: EMPTY_CAPABILITIES },
          { slug: "openrouter/@preset/budget-ds-flash", name: "Budget DS Flash", isCustom: false, capabilities: EMPTY_CAPABILITIES },
          { slug: "openrouter/@preset/glm-5.3-flash", name: "GLM Flash", isCustom: false, capabilities: EMPTY_CAPABILITIES },
        ],
        slashCommands: [],
        skills: [],
        setup: { canAuthenticate: false, canInstall: false },
        supportsConversationRollback: false,
        supportsTextGeneration: false,
        message: settings.enabled ? "oh-my-pi ACP is ready to start." : "oh-my-pi is disabled in provider settings.",
      });
      const adapter = yield* makeOmpAdapter({ instanceId, binaryPath: settings.binaryPath, environment: mergeProviderInstanceEnvironment(environment), childProcessSpawner: spawner });
      const providerShape: ServerProviderShape = {
        resolveMaintenance: () => Effect.succeed(makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName: "@oh-my-pi/pi-coding-agent" })),
        getSnapshot: Effect.succeed(snapshot),
        refresh: Effect.succeed(snapshot),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
      };
      return {
        instanceId, driverKind: DRIVER_KIND, continuationIdentity: continuation, displayName, accentColor, enabled,
        snapshot: providerShape,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }).pipe(Effect.mapError((cause) => Schema.is(ProviderDriverError)(cause) ? cause : new ProviderDriverError({ driver: DRIVER_KIND, instanceId, detail: "Could not create omp provider.", cause }))),
};
