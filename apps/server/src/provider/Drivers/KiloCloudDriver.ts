import { KiloCloudSettings, TextGenerationError, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../config.ts";
import * as CloudAdapter from "../../orchestration-v2/Adapters/KiloCloudAdapterV2.ts";
import * as Account from "../kilo/KiloCloudAccount.ts";
import * as Cloud from "../kilo/KiloCloudWebClient.ts";
import * as Journal from "../kilo/KiloCloudJournal.ts";
import { ProviderDriverError } from "../Errors.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const kind = CloudAdapter.KILO_CLOUD_PROVIDER;
const decode = Schema.decodeSync(KiloCloudSettings);
type Requirements =
  | Effect.Services<ReturnType<typeof Account.make>>
  | Effect.Services<ReturnType<typeof Journal.make>>
  | Effect.Services<ReturnType<typeof CloudAdapter.make>>
  | ServerConfig.ServerConfig;
export type KiloCloudDriverEnv = Exclude<Requirements, Scope.Scope>;
export const KiloCloudDriver: ProviderDriver<KiloCloudSettings, KiloCloudDriverEnv> = {
  driverKind: kind,
  metadata: { displayName: "Kilo Cloud", supportsMultipleInstances: true },
  configSchema: KiloCloudSettings,
  defaultConfig: () => decode({}),
  create: (input) =>
    Effect.gen(function* () {
      const server = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const account = yield* Account.make(input.config.profileDirectory);
      const credentials = yield* account.load;
      const identity = [
        input.instanceId,
        path.resolve(input.config.profileDirectory),
        credentials.accountId,
        input.config.repository,
        input.config.branch,
      ].join("\0");
      const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(identity));
      const continuationKey = `kilo-cloud:${Hex.encode(digest)}`;
      const journal = yield* Journal.make(
        path.join(server.stateDir, "providers", "kilo-cloud", Hex.encode(digest)),
      );
      const client = Cloud.make({ ...credentials, credentials: account.load });
      const adapter = yield* CloudAdapter.make({
        instanceId: input.instanceId,
        continuationKey,
        accountId: credentials.accountId,
        repository: input.config.repository,
        branch: input.config.branch,
        client,
        journal,
        allowAdmission: input.enabled && input.config.cloudConsent,
      });
      const configured =
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.config.repository) &&
        input.config.cloudConsent;
      const changes = yield* PubSub.unbounded<ServerProvider>();
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      let snapshot: ServerProvider = {
        ...buildServerProvider({
          driver: kind,
          enabled: input.enabled,
          presentation: {
            displayName: "Kilo Cloud",
            badgeLabel: "Preview",
            supportsConversationRollback: false,
            showInteractionModeToggle: false,
            supportedRuntimeModes: ["full-access"],
          },
          checkedAt,
          models: [
            {
              slug: input.config.model,
              name: input.config.model,
              isCustom: false,
              isDefault: true,
              capabilities: {
                optionDescriptors:
                  input.config.model === "deepseek/deepseek-v4.1-flash"
                    ? [
                        {
                          id: "variant",
                          label: "Reasoning",
                          type: "select",
                          options: [{ id: "low", label: "Low", isDefault: true }],
                        },
                      ]
                    : [],
              },
            },
          ],
          probe: {
            installed: true,
            version: null,
            status: configured ? "ready" : "warning",
            auth: { status: "authenticated", profileId: credentials.accountId },
            message: configured
              ? "Kilo Cloud uses the configured remote repository and Kilo credit. Only Full access is supported; cloud tools and subagents cannot be restricted. No local files are uploaded. Model availability and remote runtime version are unverified until a task runs."
              : "Choose a GitHub repository and allow paid cloud execution before starting a task.",
          },
        }),
        instanceId: input.instanceId,
        driver: kind,
        displayName: input.displayName ?? "Kilo Cloud",
        continuation: { groupKey: continuationKey },
      };
      const authenticatedSnapshot = snapshot;
      const unavailable = (
        operation: "commit-message" | "pr-content" | "branch-name" | "thread-title",
      ) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail:
              "Kilo Cloud does not generate local workspace metadata or start background paid tasks.",
          }),
        );
      return {
        instanceId: input.instanceId,
        driverKind: kind,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: input.enabled,
        continuationIdentity: { driverKind: kind, continuationKey },
        orchestrationAdapter: adapter,
        textGeneration: {
          generateCommitMessage: () => unavailable("commit-message"),
          generatePrContent: () => unavailable("pr-content"),
          generateBranchName: () => unavailable("branch-name"),
          generateThreadTitle: () => unavailable("thread-title"),
        },
        snapshot: {
          getSnapshot: Effect.sync(() => snapshot),
          refresh: Effect.gen(function* () {
            const current = yield* account.load.pipe(Effect.result);
            if (current._tag === "Success" && current.success.accountId === credentials.accountId)
              snapshot = authenticatedSnapshot;
            else {
              const temporarilyUnavailable =
                current._tag === "Failure" && current.failure.reason === "invalid_response";
              snapshot = {
                ...snapshot,
                status: "error",
                message: temporarilyUnavailable
                  ? "Kilo account verification is temporarily unavailable. Retry later; existing remote tasks may still be running."
                  : "Kilo login changed or is unavailable. Reconfigure this cloud account; existing remote tasks may still be running.",
              };
            }
            yield* PubSub.publish(changes, snapshot);
            return snapshot;
          }),
          streamChanges: Stream.fromPubSub(changes),
          applyUsageLimits: () => Effect.void,
          resolveMaintenance: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: kind,
                packageName: "@kilocode/cli",
              }),
            ),
        },
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: kind,
            instanceId: input.instanceId,
            detail:
              "Kilo Cloud could not initialize. Use an official Kilo login in the selected profile.",
            cause,
          }),
      ),
    ),
};
