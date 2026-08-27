import {
  ProviderDriverKind,
  PostHogNotConfiguredError,
  TextGenerationError,
  type PostHogCloudModel,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { PostHogClient } from "../../posthog/PostHogClient.ts";
import { makePostHogCloudAdapter } from "../Layers/PostHogCloudAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("posthogCloud");
const PostHogCloudSettings = Schema.Struct({});
type PostHogCloudSettings = typeof PostHogCloudSettings.Type;

export type PostHogCloudDriverEnv = Crypto.Crypto | FileSystem.FileSystem;

function reasoningCapabilities(
  model: PostHogCloudModel,
): ServerProvider["models"][number]["capabilities"] {
  if (model.supported_efforts.length === 0) return null;
  return {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: model.supported_efforts.map((effort, index) => ({
          id: effort,
          label: effort,
          ...(index === 0 ? { isDefault: true } : {}),
        })),
      },
    ],
  };
}

function textGenerationUnavailable(operation: string) {
  return Effect.fail(
    new TextGenerationError({
      operation,
      detail: "PostHog Cloud models are only available for Cloud Task threads.",
    }),
  );
}

export const PostHogCloudDriver: ProviderDriver<PostHogCloudSettings, PostHogCloudDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "PostHog Cloud",
    supportsMultipleInstances: false,
  },
  configSchema: PostHogCloudSettings,
  defaultConfig: () => ({}),
  create: ({ instanceId, displayName, accentColor, enabled }) =>
    Effect.gen(function* () {
      const missing = () =>
        Effect.fail(new PostHogNotConfiguredError({ missing: ["apiKey"] as const }));
      const posthog = Option.getOrElse(yield* Effect.serviceOption(PostHogClient), () =>
        PostHogClient.of({
          listReports: missing,
          listReportArtefacts: missing,
          listReportSignals: missing,
          setReportState: missing,
          getCurrentUser: missing,
          setReviewers: missing,
          listCloudModels: missing,
          createCloudTask: missing,
          runCloudTask: missing,
          getCloudRun: missing,
          commandCloudRun: missing,
          cancelCloudRun: missing,
          uploadCloudRunArtifacts: missing,
          readCloudRunLogs: missing,
          streamCloudRun: missing,
        }),
      );
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const adapter = yield* makePostHogCloudAdapter({ instanceId, posthog, fileSystem });
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });

      const loadSnapshot = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const result = yield* posthog.listCloudModels().pipe(Effect.result);
        const models = result._tag === "Success" ? result.success : [];
        return {
          instanceId,
          driver: DRIVER_KIND,
          displayName: displayName ?? "PostHog Cloud",
          ...(accentColor ? { accentColor } : {}),
          badgeLabel: "Cloud",
          continuation: { groupKey: continuationIdentity.continuationKey },
          showInteractionModeToggle: false,
          requiresNewThreadForModelChange: true,
          enabled,
          installed: enabled && result._tag === "Success",
          version: null,
          status: !enabled ? "disabled" : result._tag === "Success" ? "ready" : "warning",
          auth: {
            status: result._tag === "Success" ? "authenticated" : "unknown",
            type: "PostHog personal API key",
          },
          checkedAt,
          ...(result._tag === "Failure"
            ? { message: "Configure PostHog to use Cloud Tasks." }
            : {}),
          availability: "available",
          models: models.map((model, index) => ({
            slug: `${model.runtime_adapter}:${model.model}`,
            name: model.display_name,
            shortName: model.display_name,
            subProvider: model.runtime_adapter === "codex" ? "Codex" : "Claude",
            isCustom: false,
            ...(index === 0 ? { isDefault: true } : {}),
            capabilities: reasoningCapabilities(model),
          })),
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
      });

      const snapshot = {
        maintenanceCapabilities,
        getSnapshot: loadSnapshot,
        refresh: loadSnapshot,
        streamChanges: Stream.empty,
      };
      const textGeneration = {
        generateCommitMessage: () => textGenerationUnavailable("generateCommitMessage"),
        generatePrContent: () => textGenerationUnavailable("generatePrContent"),
        generateBranchName: () => textGenerationUnavailable("generateBranchName"),
        generateThreadTitle: () => textGenerationUnavailable("generateThreadTitle"),
      };

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
