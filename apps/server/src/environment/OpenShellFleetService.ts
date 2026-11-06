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
import * as ServerConfig from "../config.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as OpenShellFleetStore from "../environment/OpenShellFleetStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerEnvironmentRegistry from "../peer/PeerEnvironmentRegistry.ts";

/** ServerSecretStore slot holding the gateway credential (spec section 4.2). */
const GATEWAY_CREDENTIAL_SLOT = "openshell-gateway-credential";

const isDriverError = Schema.is(OpenShellGatewayDriverError);

const offHere = "OpenShell fleet management is off here.";

export class OpenShellFleetDisabled extends Schema.TaggedError<OpenShellFleetDisabled>()(
  "OpenShellFleetDisabled",
  { message: Schema.String },
) {}

export class OpenShellFleetSpawnRefused extends Schema.TaggedError<OpenShellFleetSpawnRefused>()(
  "OpenShellFleetSpawnRefused",
  {
    reason: Schema.Literals(["runtime_mode_above_ceiling", "unknown_template"]),
    message: Schema.String,
  },
) {}

export class OpenShellFleetOperationFailed extends Schema.TaggedError<OpenShellFleetOperationFailed>()(
  "OpenShellFleetOperationFailed",
  {
    operation: Schema.Literals(["spawn", "remove", "list"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type OpenShellFleetError =
  | OpenShellFleetDisabled
  | OpenShellFleetSpawnRefused
  | OpenShellFleetOperationFailed;

const describe = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

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

  // One client per process: a gateway-url change applies after a restart.
  const parts = yield* Ref.make<Option.Option<OpenShellGatewayDriver>>(Option.none());

  const failDisabled = (message: string) => new OpenShellFleetDisabled({ message });

  const failed = (operation: OpenShellFleetOperationFailed["operation"], cause: unknown) =>
    new OpenShellFleetOperationFailed({
      operation,
      message: describe(cause, "The fleet operation failed."),
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

  /** The gateway credential, decoded for the SDK's token provider. */
  const gatewayCredential = Effect.gen(function* () {
    const stored = yield* secrets.get(GATEWAY_CREDENTIAL_SLOT).pipe(Effect.option);
    return Option.isSome(stored) && Option.isSome(stored.value)
      ? new TextDecoder().decode(stored.value.value)
      : undefined;
  });

  const openClient = Effect.fn("OpenShellFleetService.openClient")(function* (
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
      catch: (cause) => failed("spawn", cause),
    });
    return client;
  });

  /** Nothing is deleted before its data is here (spec section 7). */
  const drainFor = Effect.fn("OpenShellFleetService.drainFor")(function* (
    client: OpenShellGatewayClient,
  ) {
    const context = yield* Effect.context<never>();
    const executor = OpenShellFleetDrain.makeDrainExecutor({
      source: OpenShellFleetDrainAdapters.linkDrainSource({
        resolve: (environmentId) =>
          links.resolve(environmentId).pipe(
            Effect.mapError(
              (cause) =>
                new OpenShellFleetDrain.FleetDrainStepError({
                  step: "shell",
                  message: cause instanceof Error ? cause.message : "The worker link is unusable.",
                }),
            ),
          ),
        http,
      }),
      sink: OpenShellFleetDrainAdapters.fileDrainSink({ stateDir: config.stateDir, fs, path }),
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
    return OpenShellFleetDrain.asDriverPort(executor, (effect) =>
      Effect.runPromiseWith(context)(effect),
    );
  });

  const buildDriver = Effect.gen(function* () {
    const { gatewayUrl, openshell } = yield* gatewaySettings;
    const credential = yield* gatewayCredential;
    const client = yield* openClient(gatewayUrl, credential);
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
    return new OpenShellGatewayDriver({
      client,
      settings: driverSettings,
      ...(Option.isSome(selfId) ? { managingEnvironmentId: selfId.value } : {}),
      registrar,
      index,
      drainExecutor: yield* drainFor(client),
    });
  });

  const driverFor = Effect.gen(function* () {
    const cached = yield* Ref.get(parts);
    if (Option.isSome(cached)) return cached.value;
    const driver = yield* buildDriver;
    yield* Ref.set(parts, Option.some(driver));
    return driver;
  });

  const spawnWorker: OpenShellFleetService["Service"]["spawnWorker"] = Effect.fn(
    "OpenShellFleetService.spawnWorker",
  )(function* (input): Effect.fn.Return<GatewayDriverSpawnResult, OpenShellFleetError> {
    // Inherit means the caller's own mode (spec section 5.2: never broader).
    const runtimeMode =
      input.runtimeMode === undefined || input.runtimeMode === "inherit"
        ? input.runtimeModeCeiling
        : input.runtimeMode;
    if (isRuntimeModeAbove(runtimeMode, input.runtimeModeCeiling)) {
      return yield* new OpenShellFleetSpawnRefused({
        reason: "runtime_mode_above_ceiling",
        message: `Worker policy ${runtimeMode} is broader than this caller's ${input.runtimeModeCeiling} ceiling.`,
      });
    }
    const driver = yield* driverFor;
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
    const driver = yield* driverFor;
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
    const driver = yield* driverFor;
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
