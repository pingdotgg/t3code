import {
  HERMES_DRIVER_KIND,
  HERMES_GATEWAY_PROTOCOL_VERSION,
  HermesGatewayRequestId,
  HermesSettings,
  TextGenerationError,
  type HermesGatewayInstanceStatus,
  type HermesGatewayModelsListResponse,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { readHomeThreadId } from "../../orchestration/homeThreads.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { hermesServerModels } from "../hermesModels.ts";
import { HermesGatewayBroker } from "../Services/HermesGatewayBroker.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const HERMES_CATALOG_RETRY_DELAYS = ["250 millis", "1 second"] as const;

interface HermesCatalogRequest {
  readonly generation: number;
  readonly cycleId: number;
  readonly requestId: HermesGatewayRequestId;
}

interface HermesCatalogState {
  readonly nextRequestEpoch: number;
  readonly observedGeneration: number | null;
  readonly activeRequest: HermesCatalogRequest | null;
  readonly catalogGeneration: number | null;
  readonly catalog: HermesGatewayModelsListResponse | undefined;
}

const isSameCatalogRequest = (
  active: HermesCatalogRequest | null,
  expected: HermesCatalogRequest,
) =>
  active?.generation === expected.generation &&
  active.cycleId === expected.cycleId &&
  active.requestId === expected.requestId;

export type HermesDriverEnv =
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ServerConfig
  | ServerSettingsService;

const unsupportedTextGeneration = (
  operation:
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle",
) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Hermes gateway instances do not support utility text generation.",
    }),
  );

const makeTextGeneration = (): TextGenerationShape => ({
  generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
  generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
  generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
  generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
});

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: HERMES_DRIVER_KIND,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: () => decodeHermesSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled }) =>
    Effect.gen(function* () {
      const broker = yield* HermesGatewayBroker;
      const instanceScope = yield* Scope.Scope;
      const crypto = yield* Crypto.Crypto;
      const requestNamespace = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: HERMES_DRIVER_KIND,
              instanceId,
              detail: "Failed to generate a Hermes catalog request namespace.",
              cause,
            }),
        ),
      );
      const instanceClosed = yield* Deferred.make<void>();
      const catalogChanges = yield* PubSub.unbounded<void>();
      yield* Scope.addFinalizer(
        instanceScope,
        Deferred.succeed(instanceClosed, undefined).pipe(
          Effect.andThen(PubSub.shutdown(catalogChanges)),
          Effect.ignore,
        ),
      );
      const catalogState = yield* Ref.make<HermesCatalogState>({
        nextRequestEpoch: 0,
        observedGeneration: null,
        activeRequest: null,
        catalogGeneration: null,
        catalog: undefined,
      });
      // Captured once at construction: `getSnapshot` must be context-free
      // (`R = never`) because the registry calls it outside this scope.
      const settings = yield* ServerSettingsService;
      const adapter = yield* makeHermesAdapter({ instanceId });
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: HERMES_DRIVER_KIND,
        instanceId,
      });
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: HERMES_DRIVER_KIND,
        packageName: null,
      });

      /**
       * Catalog discovery can touch cached provider inventories on the remote
       * Hermes host, so it never blocks a snapshot read. One request is
       * launched per connection generation; transient failures retry with a
       * short bounded backoff, and completion publishes a second snapshot with
       * the real picker choices.
       */
      const scheduleCatalogRefresh = (
        status: HermesGatewayInstanceStatus | undefined,
        connected: boolean,
        force: boolean,
      ) =>
        Effect.gen(function* () {
          const generation = connected ? (status?.connectionGeneration ?? null) : null;
          if (generation === null) {
            yield* Ref.update(catalogState, (current) => ({
              ...current,
              observedGeneration: null,
              activeRequest: null,
            }));
            return;
          }

          const claimed = yield* Ref.modify(catalogState, (current) => {
            // Connection generations are monotonic for the lifetime of this
            // driver. A snapshot that read the previous status must not
            // displace a request already claimed by the replacement socket.
            if (current.observedGeneration !== null && generation < current.observedGeneration) {
              return [undefined, current] as const;
            }
            if (
              !force &&
              current.observedGeneration === generation &&
              (current.activeRequest?.generation === generation ||
                current.catalogGeneration === generation)
            ) {
              return [undefined, current] as const;
            }
            const candidate: HermesCatalogRequest = {
              generation,
              cycleId: current.nextRequestEpoch,
              requestId: HermesGatewayRequestId.make(
                `t3-models-${instanceId}-${generation}-${requestNamespace}-${current.nextRequestEpoch}`,
              ),
            };
            return [
              candidate,
              {
                ...current,
                nextRequestEpoch: current.nextRequestEpoch + 1,
                observedGeneration: generation,
                activeRequest: candidate,
              },
            ] as const;
          });
          if (claimed === undefined) return;

          const requestIsCurrent = (request: HermesCatalogRequest) =>
            Effect.gen(function* () {
              const stillConnected = yield* broker.isConnected(instanceId);
              const latestStatus = Option.getOrUndefined(
                yield* broker.getInstanceStatus(instanceId).pipe(Effect.option),
              );
              const latestGeneration = stillConnected
                ? (latestStatus?.connectionGeneration ?? null)
                : null;

              return yield* Ref.modify(catalogState, (current) => {
                if (!isSameCatalogRequest(current.activeRequest, request)) {
                  return [false, current] as const;
                }
                if (latestGeneration !== request.generation) {
                  return [
                    false,
                    {
                      ...current,
                      observedGeneration: latestGeneration,
                      activeRequest: null,
                    },
                  ] as const;
                }
                return [true, current] as const;
              });
            });

          const load = Effect.gen(function* () {
            let request = claimed;

            for (let attempt = 0; ; attempt += 1) {
              if (!(yield* requestIsCurrent(request))) return;

              const response = Option.getOrUndefined(
                yield* broker
                  .request(instanceId, {
                    type: "models.list.request",
                    protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
                    requestId: request.requestId,
                  })
                  .pipe(Effect.option),
              );

              if (
                response?.type === "models.list.response" &&
                response.requestId === request.requestId &&
                (yield* requestIsCurrent(request))
              ) {
                const stored = yield* Ref.modify(catalogState, (current) =>
                  isSameCatalogRequest(current.activeRequest, request)
                    ? [
                        true,
                        {
                          ...current,
                          activeRequest: null,
                          catalogGeneration: request.generation,
                          catalog: response,
                        },
                      ]
                    : [false, current],
                );
                if (stored) yield* PubSub.publish(catalogChanges, undefined);
                return;
              }

              const delay = HERMES_CATALOG_RETRY_DELAYS[attempt];
              if (delay === undefined) return;
              yield* Effect.sleep(delay);
              if (!(yield* requestIsCurrent(request))) return;

              const retry = yield* Ref.modify(catalogState, (current) => {
                if (!isSameCatalogRequest(current.activeRequest, request)) {
                  return [undefined, current] as const;
                }
                const next: HermesCatalogRequest = {
                  generation: request.generation,
                  cycleId: request.cycleId,
                  requestId: HermesGatewayRequestId.make(
                    `t3-models-${instanceId}-${request.generation}-${requestNamespace}-${current.nextRequestEpoch}`,
                  ),
                };
                return [
                  next,
                  {
                    ...current,
                    nextRequestEpoch: current.nextRequestEpoch + 1,
                    activeRequest: next,
                  },
                ] as const;
              });
              if (retry === undefined) return;
              request = retry;
            }
          }).pipe(
            // Scope interruption must release this cycle without clearing a
            // newer request claimed by refresh or a replacement connection.
            Effect.ensuring(
              Ref.update(catalogState, (current) =>
                current.activeRequest?.generation === claimed.generation &&
                current.activeRequest.cycleId === claimed.cycleId
                  ? { ...current, activeRequest: null }
                  : current,
              ),
            ),
          );
          yield* load.pipe(Effect.forkIn(instanceScope));
        });

      const snapshotFromStatus = (
        connected: boolean,
        status: HermesGatewayInstanceStatus | undefined,
        catalog: HermesGatewayModelsListResponse | undefined,
      ) =>
        Effect.gen(function* () {
          // Read-only: a snapshot must never create the thread as a side effect
          // (this runs on every status tick). The handshake owns creation.
          // A settings read that fails degrades to "no designation" rather than
          // failing the whole snapshot — the pin is cosmetic, the status is not.
          const currentSettings = yield* settings.getSettings.pipe(
            Effect.map(Option.some),
            Effect.orElseSucceed(() => Option.none<ServerSettings>()),
          );
          const homeThreadId = Option.isSome(currentSettings)
            ? readHomeThreadId(currentSettings.value.providerInstances[instanceId])
            : undefined;
          return {
            ...(homeThreadId !== undefined ? { homeThreadId } : {}),
            instanceId,
            driver: HERMES_DRIVER_KIND,
            ...(displayName ? { displayName } : {}),
            ...(accentColor ? { accentColor } : {}),
            continuation: { groupKey: continuationIdentity.continuationKey },
            showInteractionModeToggle: false,
            requiresNewThreadForModelChange: false,
            requiresWorkspace: false,
            enabled,
            installed: true,
            version: status?.hermesVersion ?? null,
            status: !enabled ? "disabled" : connected ? "ready" : "warning",
            auth: {
              status: connected ? "authenticated" : "unauthenticated",
              type: "gateway",
              label: status?.nickname ?? displayName ?? "Hermes",
            },
            checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
            ...(!connected && enabled
              ? { message: "Hermes is offline. Reconnect its T3 Code gateway plugin." }
              : {}),
            availability: "available",
            // Keep the stable `hermes` sentinel for every existing thread, then
            // add provider-qualified catalog entries once the live plugin has
            // answered the asynchronous inventory request.
            models: hermesServerModels({ reportedModel: status?.model, catalog }),
            slashCommands: [],
            skills: [],
          } satisfies ServerProvider;
        });

      const readSnapshot = (forceCatalogRefresh: boolean) =>
        Effect.gen(function* () {
          const connected = yield* broker.isConnected(instanceId);
          const status = Option.getOrUndefined(
            yield* broker.getInstanceStatus(instanceId).pipe(Effect.option),
          );
          yield* scheduleCatalogRefresh(status, connected, forceCatalogRefresh);
          const state = yield* Ref.get(catalogState);
          const generation = connected ? (status?.connectionGeneration ?? null) : null;
          const catalog =
            generation !== null && state.catalogGeneration === generation
              ? state.catalog
              : undefined;
          return yield* snapshotFromStatus(connected, status, catalog);
        });
      const getSnapshot = readSnapshot(false);
      const snapshot = {
        maintenanceCapabilities,
        getSnapshot,
        refresh: readSnapshot(true),
        streamChanges: Stream.merge(
          broker.streamStatuses.pipe(
            Stream.filter((status) => status.instanceId === instanceId),
            Stream.mapEffect(() => getSnapshot),
            Stream.interruptWhen(Deferred.await(instanceClosed)),
          ),
          Stream.fromPubSub(catalogChanges).pipe(Stream.mapEffect(() => getSnapshot)),
        ),
      };

      return {
        instanceId,
        driverKind: HERMES_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: makeTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
