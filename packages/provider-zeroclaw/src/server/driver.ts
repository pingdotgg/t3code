// ZeroClaw driver. The snapshot probe connects, handshakes, and lists agents
// and models. It never opens a session.
import {
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import { makeZeroClawAdapterV2 } from "./adapter.ts";
import { INITIALIZE_PARAMS, decodeAgentsListResult, decodeStatusResult } from "./protocol.ts";
import { makeZeroClawRpcConnection } from "./rpc.ts";
import { ZeroClawSettings } from "../settings.ts";

const DRIVER_KIND = ProviderDriverKind.make("zeroclaw");
const CATALOG_TTL_MS = 15 * 60 * 1000;

const decodeSettings = Schema.decodeSync(ZeroClawSettings);

export type ZeroClawDriverEnv = Path.Path;

interface CatalogCache {
  readonly at: number;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly agents: ReadonlyArray<string>;
  readonly version: string | undefined;
}

const unsupported = Effect.fail(
  new TextGenerationError({
    operation: "generate",
    detail: "ZeroClaw does not generate commit messages, titles, or review text.",
  }),
);

const unsupportedTextGeneration: ProviderTextGeneration = {
  generateTranscriptionPostProcessing: () => unsupported,
  generateCommitMessage: () => unsupported,
  generatePrContent: () => unsupported,
  generateBranchName: () => unsupported,
  generateThreadTitle: () => unsupported,
  generateReviewGuide: () => unsupported,
};

function warningSnapshot(
  instanceId: ProviderInstance["instanceId"],
  message: string,
  checkedAt: string,
): ServerProvider {
  return {
    instanceId,
    driver: DRIVER_KIND,
    displayName: "ZeroClaw",
    enabled: false,
    installed: false,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    checkedAt,
    message,
    models: [],
    slashCommands: [],
    skills: [],
    supportedRuntimeModes: ["approval-required"],
    supportsConversationRollback: false,
    supportsTextGeneration: false,
    showInteractionModeToggle: false,
  };
}

function readySnapshot(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly checkedAt: string;
  readonly version: string | undefined;
}): ServerProvider {
  return {
    ...warningSnapshot(input.instanceId, "", input.checkedAt),
    status: "ready",
    installed: true,
    version: input.version ?? null,
    message: undefined,
    models: [
      { slug: "default", name: "Agent default", isCustom: false, capabilities: null },
      ...input.models,
    ],
  };
}

/**
 * Probe a daemon without opening a session. A missing socket is a warning
 * snapshot, never a thrown defect.
 */
export const probeZeroClaw = Effect.fn("probeZeroClaw")(function* (input: {
  readonly socketPath: string;
  readonly instanceId: ProviderInstance["instanceId"];
  readonly cache: { current: CatalogCache | undefined };
}) {
  const now = yield* DateTime.now;
  const checkedAt = DateTime.formatIso(now);
  if (input.socketPath.length === 0) {
    return warningSnapshot(
      input.instanceId,
      "No ZeroClaw socket is configured. Set the daemon socket path or start `zeroclaw daemon`.",
      checkedAt,
    );
  }
  const cached = input.cache.current;
  if (cached !== undefined && DateTime.toEpochMillis(now) - cached.at < CATALOG_TTL_MS) {
    return readySnapshot({
      instanceId: input.instanceId,
      checkedAt,
      models: cached.models,
      version: cached.version,
    });
  }
  const probed = yield* Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* makeZeroClawRpcConnection({ socketPath: input.socketPath });
      yield* connection.request("initialize", INITIALIZE_PARAMS);
      const status = yield* connection.request("status", {}).pipe(
        Effect.flatMap(decodeStatusResult),
        Effect.orElseSucceed(() => ({ version: undefined })),
      );
      const agents = yield* connection
        .request("agents/list", {})
        .pipe(Effect.flatMap(decodeAgentsListResult));
      const catalog = yield* connection
        .request("config/catalog", {})
        .pipe(Effect.orElseSucceed(() => ({ model_providers: [] })));
      // The daemon returns `{ model_providers: [{ name, display_name, local }] }`.
      const listedProviders = (catalog as { model_providers?: unknown }).model_providers;
      const providers = Array.isArray(listedProviders)
        ? listedProviders.flatMap((provider: unknown) =>
            typeof provider === "object" &&
            provider !== null &&
            typeof (provider as { name?: unknown }).name === "string"
              ? [(provider as { name: string }).name]
              : [],
          )
        : [];
      const models: ServerProviderModel[] = [];
      for (const provider of providers) {
        const listed = yield* connection
          .request("config/catalog-models", { model_provider: provider })
          .pipe(Effect.orElseSucceed(() => ({ models: [] as string[] })));
        const names = Array.isArray((listed as { models?: unknown }).models)
          ? ((listed as { models: unknown[] }).models.filter(
              (model) => typeof model === "string",
            ) as string[])
          : [];
        for (const name of names) {
          models.push({
            slug: `${provider}/${name}`,
            name,
            subProvider: provider,
            isCustom: false,
            capabilities: null,
          });
        }
      }
      return {
        kind: "ready" as const,
        version: status.version,
        agents: agents.agents
          .filter((agent) => agent.enabled !== false)
          .map((agent) => agent.alias),
        models,
      };
    }),
  ).pipe(
    Effect.match({
      onFailure: (cause) => ({
        kind: "warning" as const,
        snapshot: warningSnapshot(
          input.instanceId,
          `ZeroClaw daemon is not reachable at ${input.socketPath}: ${cause.message}`,
          checkedAt,
        ),
      }),
      onSuccess: (ready) => ready,
    }),
  );
  if (probed.kind === "warning") return probed.snapshot;
  input.cache.current = {
    at: DateTime.toEpochMillis(now),
    models: probed.models,
    agents: probed.agents,
    version: probed.version,
  };
  return readySnapshot({
    instanceId: input.instanceId,
    checkedAt,
    models: probed.models,
    version: probed.version,
  });
});

export function agentOptionDescriptor(agents: ReadonlyArray<string>) {
  return {
    id: "agent",
    type: "select" as const,
    label: "Agent",
    options: agents.map((alias) => ({ id: alias, label: alias })),
  };
}

export const ZeroClawDriver: ProviderDriver<ZeroClawSettings, ZeroClawDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "ZeroClaw", supportsMultipleInstances: true },
  configSchema: ZeroClawSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("ZeroClawDriver.create")(function* (input) {
    const cache: { current: CatalogCache | undefined } = { current: undefined };
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const environment = yield* mergeProviderInstanceEnvironment(
      input.environment,
      yield* HostProcess.Environment,
    );
    const configured = input.config.socketPath.trim() || environment.ZEROCLAW_SOCKET?.trim();
    const dataDir = path.join(
      expandHomePath(
        environment.ZEROCLAW_CONFIG_DIR?.trim() ||
          path.join(environment.HOME?.trim() || home, ".zeroclaw"),
        home,
      ),
      "data",
    );
    const socketPath = expandHomePath(configured || path.join(dataDir, "daemon.sock"), home);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId: input.instanceId,
    });
    const stampSnapshot = (snapshot: ServerProvider): ServerProvider => ({
      ...snapshot,
      enabled: input.enabled,
      displayName: input.displayName ?? "ZeroClaw",
      ...(input.accentColor === undefined ? {} : { accentColor: input.accentColor }),
      continuation: { groupKey: continuationIdentity.continuationKey },
    });
    const check = input.enabled
      ? probeZeroClaw({ socketPath, instanceId: input.instanceId, cache })
      : Effect.succeed({
          ...warningSnapshot(
            input.instanceId,
            "ZeroClaw is disabled.",
            DateTime.formatIso(yield* DateTime.now),
          ),
          status: "disabled" as const,
        });
    const snapshot = yield* SubscriptionRef.make(stampSnapshot(yield* check));
    const refresh = Effect.gen(function* () {
      cache.current = undefined;
      const next = stampSnapshot(yield* check);
      yield* SubscriptionRef.set(snapshot, next);
      return next;
    });
    const adapter = yield* makeZeroClawAdapterV2({
      instanceId: input.instanceId,
      settings: input.config,
      resolveSocketPath: () => Effect.succeed(socketPath),
    });
    const instance: ProviderInstance = {
      instanceId: input.instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName: input.displayName,
      accentColor: input.accentColor,
      enabled: input.enabled,
      snapshot: {
        getSnapshot: SubscriptionRef.get(snapshot),
        refresh,
        streamChanges: SubscriptionRef.changes(snapshot),
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: DRIVER_KIND,
              packageName: null,
            }),
          ),
        applyUsageLimits: () => Effect.void,
      },
      snapshotForCwd: () =>
        SubscriptionRef.get(snapshot).pipe(
          Effect.map((current) => ({
            ...current,
            optionDescriptors: [agentOptionDescriptor(cache.current?.agents ?? [])],
            slashCommandsPending: false,
          })),
        ),
      orchestrationAdapter: adapter,
      textGeneration: unsupportedTextGeneration,
    };
    return instance;
  }),
};
