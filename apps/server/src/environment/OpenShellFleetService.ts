import {
  EnvironmentId,
  type GatewayDriverRemoveOptions,
  type GatewayDriverRemoveResult,
  type GatewayDriverSpawnResult,
  isRuntimeModeAbove,
  type OpenShellFleetWorkerStatus,
  OpenShellWorkerClass,
  type OrchestratorMcpRuntimeMode,
  type RuntimeMode,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  connectOpenShellGateway,
  type OpenShellGatewayClient,
} from "@t3tools/openshell/gatewayClient";
import {
  OpenShellGatewayDriver,
  OpenShellGatewayDriverError,
  type GatewayDriverSpawnOptionsWithCeiling,
  type OpenShellDriverSettings,
  type WorkerPairingRegistrar,
  type FleetWorkerIndex,
  type FleetWorkerRow,
} from "@t3tools/openshell/OpenShellGatewayDriver";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OpenShellFleetDrain from "../environment/OpenShellFleetDrain.ts";
import * as OpenShellFleetDrainAdapters from "../environment/OpenShellFleetDrainAdapters.ts";
import * as OpenShellFleetBundleImport from "../environment/OpenShellFleetBundleImport.ts";
import * as ServerConfig from "../config.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as OpenShellFleetStore from "../environment/OpenShellFleetStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerEnvironmentRegistry from "../peer/PeerEnvironmentRegistry.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as SqlClient from "effect/sql/SqlClient";

/** ServerSecretStore slot holding the gateway credential (spec section 4.2). */
const GATEWAY_CREDENTIAL_SLOT = "openshell-gateway-credential";
/** ServerSecretStore slot holding the driver's durable spawn fallback key. */
const FALLBACK_KEY_SLOT = "openshell-fleet-fallback-id";

const isDriverError = Schema.is(OpenShellGatewayDriverError);

const offHere = "OpenShell fleet management is off here.";
const fleetOperationFailed = "The fleet operation failed.";

export class OpenShellFleetDisabled extends Schema.TaggedError<
  OpenShellFleetDisabled,
  { readonly brand: unique symbol }
>()("OpenShellFleetDisabled", { message: Schema.String }) {}

export class OpenShellFleetSpawnRefused extends Schema.TaggedError<
  OpenShellFleetSpawnRefused,
  { readonly brand: unique symbol }
>()("OpenShellFleetSpawnRefused", {
  reason: Schema.Literals(["runtime_mode_above_ceiling", "unknown_template"]),
  message: Schema.String,
}) {}

export class OpenShellFleetOperationFailed extends Schema.TaggedError<
  OpenShellFleetOperationFailed,
  { readonly brand: unique symbol }
>()("OpenShellFleetOperationFailed", {
  operation: Schema.Literals(["spawn", "remove", "list"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export type OpenShellFleetError =
  | OpenShellFleetDisabled
  | OpenShellFleetSpawnRefused
  | OpenShellFleetOperationFailed;

/**
 * The OpenShell fleet on this managing instance (spec sections 5 and 6). The
 * drain data plane (spec section 7) is not injected yet, so removal refuses and
 * keeps the sandbox: nothing lost outranks cleanup.
 */
export class OpenShellFleetService extends Context.Service<
  OpenShellFleetService,
  {
    readonly spawnWorker: (input: {
      readonly template?: string;
      readonly runtimeMode?: OrchestratorMcpRuntimeMode;
      readonly runtimeModeCeiling: RuntimeMode;
      readonly workerClass: OpenShellWorkerClass;
      readonly label?: string;
      readonly ttlMs?: number;
      readonly seedFrom?: string;
      readonly clientRequestId?: string;
    }) => Effect.Effect<GatewayDriverSpawnResult, OpenShellFleetError>;
    readonly removeWorker: (input: {
      readonly targetEnvironmentId: EnvironmentId;
      readonly drainTimeoutMs?: number;
      readonly force?: boolean;
      readonly clientRequestId?: string;
    }) => Effect.Effect<GatewayDriverRemoveResult, OpenShellFleetError>;
    readonly listWorkers: (input: {
      readonly workerClass?: OpenShellWorkerClass;
    }) => Effect.Effect<ReadonlyArray<OpenShellFleetWorkerStatus>, OpenShellFleetError>;
  }
>()("t3/environment/OpenShellFleetService") {}

const toIndexRow = (row: OpenShellFleetStore.FleetEnvironment): FleetWorkerRow => ({
  environmentId: row.environmentId,
  state: row.state,
  workerClass: row.workerClass,
  label: row.label,
  sandboxName: row.sandboxName,
  sandboxId: row.sandboxId,
  drain: row.drain,
  expiresAt: row.expiresAt,
  lastError: row.lastError,
});

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const registry = yield* PeerEnvironmentRegistry.PeerEnvironmentRegistry;
  const store = yield* OpenShellFleetStore.OpenShellFleetStore;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const links = yield* PeerLinks.PeerLinks;
  // The post-drain bundle import writes through the same event sink and import
  // table the orchestration projections use, so imported threads are ordinary
  // archived threads (spec section 7.4). Optional: hosts that do not build the
  // orchestration runtime keep draining, and the import warns on the row.
  const maybeEventSink = yield* Effect.serviceOption(EventSink.EventSinkV2);
  const maybeSql = yield* Effect.serviceOption(SqlClient.SqlClient);

  // One client per process: a gateway-url change applies after a restart.
  // `cached` also serializes concurrent first calls, so two callers cannot build
  // drivers against two different gateways and cache the wrong one. A failed
  // build is not cached, so the next call retries it.
  const cachedDriver = yield* Ref.make<
    Option.Option<Effect.Effect<OpenShellGatewayDriver, OpenShellFleetError>>
  >(Option.none());

  const failDisabled = (message: string) => new OpenShellFleetDisabled({ message });

  /** A stable message for callers; the underlying detail stays in the cause. */
  const failed = (operation: OpenShellFleetOperationFailed["operation"], cause: unknown) =>
    new OpenShellFleetOperationFailed({
      operation,
      message: fleetOperationFailed,
      cause,
    });

  /** One driver call, its failures typed for the MCP tools and the driver's own refusals kept. */
  const callDriver = <A>(
    operation: OpenShellFleetOperationFailed["operation"],
    call: () => Promise<A>,
    refusal?: (error: OpenShellGatewayDriverError) => OpenShellFleetError | undefined,
  ): Effect.Effect<A, OpenShellFleetError> =>
    Effect.tryPromise({
      try: call,
      catch: (cause) => {
        const refused = isDriverError(cause) ? refusal?.(cause) : undefined;
        return refused ?? failed(operation, cause);
      },
    });

  /** The gateway block, only on an enabled managing instance with an address. */
  const gatewaySettings: Effect.Effect<
    { gatewayUrl: string; openshell: ServerSettingsValue["openshell"] },
    OpenShellFleetError
  > = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => failDisabled("The OpenShell fleet settings could not be read here.")),
    );
    const openshell = current.openshell;
    if (!current.openshellEnabled || !openshell.managingInstance) {
      return yield* failDisabled(
        "OpenShell fleet management is off here. Turn it on in Settings → Labs and make this environment the managing instance.",
      );
    }
    const gatewayUrl = openshell.gatewayUrl;
    if (gatewayUrl === undefined || gatewayUrl.trim() === "") {
      return yield* failDisabled(
        "No OpenShell gateway address is configured. Set it in Settings → Labs.",
      );
    }
    return { gatewayUrl, openshell };
  });

  /**
   * The gateway credential, decoded for the SDK's token provider. A slot that is
   * not set means "no credential"; a read that failed is a typed fleet error,
   * never silently treated as unset.
   */
  const gatewayCredential = Effect.fn("OpenShellFleetService.gatewayCredential")(function* (
    operation: OpenShellFleetOperationFailed["operation"],
  ) {
    const stored = yield* secrets
      .get(GATEWAY_CREDENTIAL_SLOT)
      .pipe(Effect.mapError((cause) => failed(operation, cause)));
    return Option.isSome(stored) ? new TextDecoder().decode(stored.value) : undefined;
  });

  const openClient = Effect.fn("OpenShellFleetService.openClient")(function* (
    operation: OpenShellFleetOperationFailed["operation"],
    gatewayUrl: string,
    credential: string | undefined,
  ) {
    const client: OpenShellGatewayClient = yield* Effect.tryPromise({
      try: () =>
        connectOpenShellGateway(
          credential === undefined
            ? { gatewayUrl }
            : { gatewayUrl, oidcTokenProvider: () => Promise.resolve(credential) },
        ),
      catch: (cause) => failed(operation, cause),
    });
    return client;
  });

  /** Nothing is deleted before its data is here (spec section 7). */
  const drainFor = Effect.fn("OpenShellFleetService.drainFor")(function* (
    client: OpenShellGatewayClient,
  ) {
    const context = yield* Effect.context<never>();
    const linkResolve = (environmentId: EnvironmentId) =>
      links.resolve(environmentId).pipe(
        Effect.mapError(
          (cause) =>
            new OpenShellFleetDrain.FleetDrainStepError({
              step: "shell",
              message: cause instanceof Error ? cause.message : "The worker link is unusable.",
            }),
        ),
      );
    const bundleImporter =
      Option.isSome(maybeEventSink) && Option.isSome(maybeSql)
        ? OpenShellFleetBundleImport.makeFleetBundleImporter({
            stateDir: config.stateDir,
            attachmentsDir: config.attachmentsDir,
            fs,
            path,
            now: Clock.currentTimeMillis,
            eventSink: maybeEventSink.value,
            store: OpenShellFleetBundleImport.sqliteFleetDrainImportStore(maybeSql.value),
          })
        : null;
    const executor = OpenShellFleetDrain.makeDrainExecutor({
      source: {
        ...OpenShellFleetDrainAdapters.linkDrainSource({ resolve: linkResolve, http }),
        // The worker's environment HTTP API serves no attachment bytes, so
        // attachment files travel over gateway exec (see execDrainAttachments).
        attachments: OpenShellFleetDrainAdapters.execDrainAttachments({
          exec: (sandboxName, command) =>
            Effect.tryPromise({
              try: () => client.exec(sandboxName, command),
              catch: (cause) =>
                new OpenShellFleetDrain.FleetDrainStepError({
                  step: "attachments",
                  message:
                    cause instanceof Error
                      ? cause.message
                      : "The worker's attachments could not be read.",
                }),
            }),
        }),
      },
      sink: yield* OpenShellFleetDrainAdapters.fileDrainSink({
        stateDir: config.stateDir,
        fs,
        path,
      }),
      git: OpenShellFleetDrainAdapters.execDrainGitPush({
        exec: (sandboxName, command) =>
          Effect.tryPromise({
            try: () => client.exec(sandboxName, command),
            catch: (cause) =>
              new OpenShellFleetDrain.FleetDrainStepError({
                step: "push",
                message: cause instanceof Error ? cause.message : "The checkout was not pushed.",
              }),
          }),
      }),
      now: Clock.currentTimeMillis,
    });
    const runBundleImport = (args: { environmentId: EnvironmentId; drainId: string }) =>
      bundleImporter === null
        ? Promise.resolve({
            imported: 0,
            skipped: 0,
            warnings: [
              "The orchestration runtime is not built here, so drained bundles were not imported.",
            ],
          })
        : Effect.runPromiseWith(context)(
            bundleImporter.importBundle({
              environmentId: args.environmentId,
              drainId: args.drainId,
            }),
          );
    return {
      port: OpenShellFleetDrain.asDriverPort(executor, (effect) =>
        Effect.runPromiseWith(context)(effect),
      ),
      bundleImporter: { import: runBundleImport },
    };
  });

  const buildDriver = Effect.fn("OpenShellFleetService.buildDriver")(function* (
    operation: OpenShellFleetOperationFailed["operation"],
  ) {
    const { gatewayUrl, openshell } = yield* gatewaySettings;
    const credential = yield* gatewayCredential(operation);
    const client = yield* openClient(operation, gatewayUrl, credential);
    // A spawn that omits a client id falls back to this durable key, so a
    // restart cannot mint a key an earlier process already used and hijack
    // that worker's sandbox.
    const durableFallbackKey = secrets.getOrCreateRandom(FALLBACK_KEY_SLOT, 32).pipe(
      Effect.map(Hex.encode),
      Effect.mapError((cause) => failed(operation, cause)),
    );
    const context = yield* Effect.context<never>();
    // The driver's collaborators are Promise-shaped because the OpenShell SDK
    // is; they run these Effects on the surrounding services rather than a
    // fresh runtime, so the sqlite store and registry stay the same instances.
    const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
      Effect.runPromiseWith(context)(effect);
    const registrar: WorkerPairingRegistrar = {
      register: (input) => run(registry.register(input)),
      exchangeBootstrap: (input) => run(registry.exchangeBootstrap(input)),
    };
    const index: FleetWorkerIndex = {
      upsert: (input) => run(store.upsert(input)).then(toIndexRow),
      setState: (environmentId, state, lastError) =>
        run(store.setState(environmentId, state, lastError)).then((row) =>
          Option.isSome(row) ? toIndexRow(row.value) : null,
        ),
      setDrain: (environmentId, drain) =>
        run(store.setDrain(environmentId, drain)).then((row) =>
          Option.isSome(row) ? toIndexRow(row.value) : null,
        ),
      get: (environmentId) =>
        run(store.get(environmentId)).then((row) =>
          Option.isSome(row) ? toIndexRow(row.value) : null,
        ),
      list: () => run(store.list).then((rows) => rows.map(toIndexRow)),
      remove: (environmentId) => run(store.remove(environmentId)),
    };
    const selfId = yield* environment.getEnvironmentId.pipe(Effect.option);
    const driverSettings: OpenShellDriverSettings = {
      ...(openshell.defaultSandboxTemplate === undefined
        ? {}
        : { defaultSandboxTemplate: openshell.defaultSandboxTemplate }),
      ...(openshell.workerDefaults === undefined
        ? {}
        : { workerDefaults: openshell.workerDefaults }),
      ...(openshell.sharedCache === undefined ? {} : { sharedCache: openshell.sharedCache }),
    };
    const drain = yield* drainFor(client);
    return new OpenShellGatewayDriver({
      client,
      settings: driverSettings,
      ...(Option.isSome(selfId) ? { managingEnvironmentId: selfId.value } : {}),
      registrar,
      index,
      drainExecutor: drain.port,
      bundleImporter: drain.bundleImporter,
      fallbackIdempotencyKey: () => run(durableFallbackKey),
    });
  });

  /** A cached build is only reused while the settings guard passes on every call. */
  const driverFor = Effect.fn("OpenShellFleetService.driverFor")(function* (
    operation: OpenShellFleetOperationFailed["operation"],
  ) {
    const cached = yield* Ref.get(cachedDriver);
    if (Option.isSome(cached)) return yield* cached.value;
    const built = yield* Effect.cached(buildDriver(operation));
    // Build first: the cached wrapper itself never fails, so without this run a
    // failed init would be stored here and replayed forever. Only a success is
    // cached, so a transient failure is retried with the next call's operation.
    const driver = yield* built;
    yield* Ref.set(cachedDriver, Option.some(built));
    return driver;
  });

  const spawnWorker: OpenShellFleetService["Service"]["spawnWorker"] = Effect.fn(
    "OpenShellFleetService.spawnWorker",
  )(function* (input): Effect.fn.Return<GatewayDriverSpawnResult, OpenShellFleetError> {
    // `inherit` follows the caller; an omitted mode falls back to the conservative
    // default the driver documents, never to the caller's ceiling (spec section 5.2).
    const runtimeMode =
      input.runtimeMode === undefined
        ? "approval-required"
        : input.runtimeMode === "inherit"
          ? input.runtimeModeCeiling
          : input.runtimeMode;
    if (isRuntimeModeAbove(runtimeMode, input.runtimeModeCeiling)) {
      return yield* new OpenShellFleetSpawnRefused({
        reason: "runtime_mode_above_ceiling",
        message: `Worker policy ${runtimeMode} is broader than this caller's ${input.runtimeModeCeiling} ceiling.`,
      });
    }
    // The guard runs per call, so disabling OpenShell after first use also
    // stops spawns; the driver itself is cached and would outlive a flip.
    yield* gatewaySettings;
    const driver = yield* driverFor("spawn");
    const options: GatewayDriverSpawnOptionsWithCeiling = {
      ...(input.clientRequestId === undefined ? {} : { idempotencyKey: input.clientRequestId }),
      runtimeModeCeiling: input.runtimeModeCeiling,
    };
    return yield* callDriver(
      "spawn",
      () =>
        driver.spawn(
          {
            ...(input.template === undefined ? {} : { template: input.template }),
            runtimeMode,
            workerClass: input.workerClass,
            ...(input.label === undefined ? {} : { label: input.label }),
            ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
            ...(input.seedFrom === undefined ? {} : { seedFrom: input.seedFrom }),
          },
          options,
        ),
      (error) =>
        error.reason === "runtime_mode_above_ceiling" || error.reason === "unknown_template"
          ? new OpenShellFleetSpawnRefused({ reason: error.reason, message: error.message })
          : undefined,
    );
  });

  const removeWorker: OpenShellFleetService["Service"]["removeWorker"] = Effect.fn(
    "OpenShellFleetService.removeWorker",
  )(function* (input): Effect.fn.Return<GatewayDriverRemoveResult, OpenShellFleetError> {
    yield* gatewaySettings;
    const driver = yield* driverFor("remove");
    const options: GatewayDriverRemoveOptions = {
      ...(input.drainTimeoutMs === undefined ? {} : { timeoutMs: input.drainTimeoutMs }),
      ...(input.force === undefined ? {} : { force: input.force }),
      ...(input.clientRequestId === undefined ? {} : { idempotencyKey: input.clientRequestId }),
    };
    return yield* callDriver("remove", () => driver.remove(input.targetEnvironmentId, options));
  });

  const listWorkers: OpenShellFleetService["Service"]["listWorkers"] = Effect.fn(
    "OpenShellFleetService.listWorkers",
  )(function* (input): Effect.fn.Return<
    ReadonlyArray<OpenShellFleetWorkerStatus>,
    OpenShellFleetError
  > {
    yield* gatewaySettings;
    const driver = yield* driverFor("list");
    return yield* callDriver("list", () =>
      driver.status(input.workerClass === undefined ? {} : { workerClass: input.workerClass }),
    );
  });

  return OpenShellFleetService.of({ spawnWorker, removeWorker, listWorkers });
});

export const layer = Layer.effect(OpenShellFleetService, make);

/**
 * No fleet here: tests and builds that do not run a gateway. Every verb fails
 * typed, so a tool that reaches it reports "off" rather than inventing workers.
 */
export const layerDisabled: Layer.Layer<OpenShellFleetService> = Layer.succeed(
  OpenShellFleetService,
  OpenShellFleetService.of({
    spawnWorker: Effect.fn("OpenShellFleetService.spawnWorker.disabled")(() =>
      Effect.fail(new OpenShellFleetDisabled({ message: offHere })),
    ),
    removeWorker: Effect.fn("OpenShellFleetService.removeWorker.disabled")(() =>
      Effect.fail(new OpenShellFleetDisabled({ message: offHere })),
    ),
    listWorkers: Effect.fn("OpenShellFleetService.listWorkers.disabled")(() =>
      Effect.fail(new OpenShellFleetDisabled({ message: offHere })),
    ),
  }),
);
