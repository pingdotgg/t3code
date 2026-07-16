import {
  HOST_API_VERSION,
  PLUGIN_ID_PATTERN_SOURCE,
  PluginManifest,
  hostApiSatisfies,
  type PluginId,
  type PluginLockfile,
  type PluginLockfilePlugin,
  type PluginState,
} from "@t3tools/contracts/plugin";
import {
  findPluginSettingsSchemaViolations,
  fingerprintSettingsSchema,
} from "@t3tools/shared/pluginSettings";
import type {
  PluginDefinition,
  PluginHostApi,
  PluginLogger,
  PluginRegistration,
  PluginServiceDescriptor,
  PluginSettingsDescriptor,
  SettingsCapability,
} from "@t3tools/plugin-sdk";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectionThreadActivities from "../persistence/Services/ProjectionThreadActivities.ts";
import * as ProjectionThreadMessages from "../persistence/Services/ProjectionThreadMessages.ts";
import * as ProjectionTurns from "../persistence/Services/ProjectionTurns.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeAgentsCapability } from "./capabilities/AgentsCapability.ts";
import { makeDatabaseCapability } from "./capabilities/DatabaseCapability.ts";
import { makeEnvironmentsReadCapability } from "./capabilities/EnvironmentsReadCapability.ts";
import { makeFilesystemCapability } from "./capabilities/FilesystemCapability.ts";
import { makeHttpCapability } from "./capabilities/HttpCapability.ts";
import {
  makeHttpClientCapability,
  PluginHttpClientTransportService,
} from "./capabilities/HttpClientCapability.ts";
import { makeProjectionsReadCapability } from "./capabilities/ProjectionsReadCapability.ts";
import { makeSecretsCapability } from "./capabilities/SecretsCapability.ts";
import { makeSourceControlCapability } from "./capabilities/SourceControlCapability.ts";
import { makeEventsCapability } from "./capabilities/EventsCapability.ts";
import { findContextDescriptorViolation, PluginContextComposer } from "./PluginContextComposer.ts";
import { PluginPolicyRegistry } from "./PluginPolicyRegistry.ts";
import { makeTerminalsCapability } from "./capabilities/TerminalsCapability.ts";
import { makeTextGenerationCapability } from "./capabilities/TextGenerationCapability.ts";
import { makeVcsCapability } from "./capabilities/VcsCapability.ts";
import { OutboundUrlLookup } from "./OutboundUrlValidator.ts";
import {
  PluginLockfileStore,
  type PluginLockfileCorruptError,
  type PluginLockfileReadError,
} from "./PluginLockfileStore.ts";
import { PluginHttpRegistry } from "./PluginHttpRegistry.ts";
import { PluginMigrator } from "./PluginMigrator.ts";
import { PluginModuleLoader } from "./PluginModuleLoader.ts";
import { makePluginLogger } from "./PluginLogger.ts";
import { pluginDataDir, pluginManifestPath, pluginVersionDir } from "./PluginPaths.ts";
import { PluginRuntimeRegistry } from "./PluginRuntimeRegistry.ts";
import { PluginSettingsStore } from "./PluginSettingsStore.ts";
import { PluginToolCatalog, PluginToolCatalogError } from "./PluginToolCatalog.ts";
import { makePluginWorkspaceGrants, type PluginWorkspaceGrants } from "./PluginWorkspaceGrants.ts";

const APP_VERSION = packageJson.version;
export const PRESERVE_DATA_MARKER = ".preserve-data-on-remove";
// Prefix for the deterministic, plugin-root-external directory that preserved data
// is parked under while a pending-remove is reconciled. Exported so the start-time
// orphan sweep and its tests agree on the exact name.
export const PRESERVED_DATA_DIR_PREFIX = ".preserved-";

// Anchored plugin-id shape used to reject a hostile `.preserved-<...>` directory
// name before it is joined into a filesystem path in the orphan sweep.
const SWEEP_PLUGIN_ID_PATTERN = new RegExp(`^${PLUGIN_ID_PATTERN_SOURCE}$`, "u");
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));

const healthyActivationDelay = () => {
  const overrideMs = Number.parseInt(process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS ?? "", 10);
  return Number.isFinite(overrideMs) && overrideMs >= 0
    ? Duration.millis(overrideMs)
    : Duration.seconds(30);
};

// Bound plugin-controlled register()/recover() so an unresponsive plugin fails
// activation via the normal failure path instead of stalling the host: a hung
// register()/recover() would otherwise block server startup or an
// install/enable request indefinitely.
const registrationTimeout = () => {
  const overrideMs = Number.parseInt(process.env.T3_PLUGIN_HOST_REGISTER_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(overrideMs) && overrideMs > 0
    ? Duration.millis(overrideMs)
    : Duration.seconds(30);
};

export class PluginRegistrationError extends Schema.TaggedErrorClass<PluginRegistrationError>()(
  "PluginRegistrationError",
  { pluginId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} returned an invalid registration: ${this.detail}`;
  }
}

// Internal control-flow sentinel: raised when an activation is intentionally
// cancelled by a concurrent lifecycle change (see the pre-put state re-check in
// loadPlugin). It is deliberately NOT part of the plugin SDK/contract surface —
// it only travels inside the host's failure channel so a self-cancel can be
// told apart from a genuine fiber interruption (host shutdown) and from a real
// activation error.
export class PluginActivationCanceled extends Schema.TaggedErrorClass<PluginActivationCanceled>()(
  "PluginActivationCanceled",
  { pluginId: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} activation was canceled: ${this.reason}`;
  }
}

// True ONLY when a cause is composed EXCLUSIVELY of the activation-cancel
// sentinel (at least one reason, and EVERY reason is the sentinel). Scope.close
// can produce a MIXED cause that combines the sentinel with a finalizer/teardown
// error/defect or a fiber interrupt; a "contains" check would fold those benign-
// looking mixed causes into the cancel branch and silently drop a real teardown
// failure or swallow a shutdown interrupt. Requiring "only" keeps a mixed cause
// out of the cancel branch. Iterating cause.reasons and narrowing with
// isFailReason is the idiomatic effect-4 way to inspect a cause for a specific
// tagged error; Schema.is is the schema-aware runtime check for the value.
// Exported for unit testing over hand-built causes.
const isActivationCanceled = Schema.is(PluginActivationCanceled);
export const causeIsActivationCanceledOnly = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) => Cause.isFailReason(reason) && isActivationCanceled(reason.error));

// True when a cause contains AT LEAST ONE interrupt reason, even when mixed with
// failures or defects. Cause.hasInterrupts is the idiomatic effect-4 "contains
// any interrupt" primitive (as opposed to hasInterruptsOnly, which is true only
// when EVERY reason is an interrupt). Any interrupt component means a host
// shutdown is in flight, so it must win over the sentinel/error branches and
// re-raise. Exported for unit testing over hand-built causes.
export const causeContainsInterrupt = (cause: Cause.Cause<unknown>): boolean =>
  Cause.hasInterrupts(cause);

export class PluginCapabilityUnavailable extends Schema.TaggedErrorClass<PluginCapabilityUnavailable>()(
  "PluginCapabilityUnavailable",
  { capability: Schema.String },
) {
  override get message(): string {
    return `Capability ${this.capability} is not available in this host build.`;
  }
}

export class PluginHost extends Context.Service<
  PluginHost,
  {
    readonly start: Effect.Effect<void>;
    // A lockfile read/parse failure now propagates (previously swallowed into a
    // silent no-op); callers treat it as an activation failure.
    readonly activatePlugin: (
      pluginId: PluginId,
    ) => Effect.Effect<void, PluginLockfileReadError | PluginLockfileCorruptError>;
    readonly deactivatePlugin: (pluginId: PluginId) => Effect.Effect<void>;
    /**
     * Runs `persist` and the matching activate/deactivate under ONE acquisition of
     * the per-plugin activation lock, so a lockfile write can never land between a
     * concurrent caller's write and its host action. Callers own the lockfile shape
     * and inject it as `persist`; the host owns the ordering.
     *
     * Prefer this over `persist; activatePlugin(...)` — that sequence is racy (see
     * the implementation comment) and left plugins in an unrecoverable state.
     */
    readonly setPluginEnabled: <E>(
      pluginId: PluginId,
      enabled: boolean,
      persist: Effect.Effect<void, E>,
    ) => Effect.Effect<void, E | PluginLockfileReadError | PluginLockfileCorruptError>;
  }
>()("t3/plugins/PluginHost") {}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

const resolveRegistration = (
  pluginId: PluginId,
  definition: PluginDefinition,
  hostApi: PluginHostApi,
) =>
  Effect.suspend(() => {
    const value = definition.register(hostApi);
    if (Effect.isEffect(value)) return value;
    if (isPromiseLike(value)) return Effect.promise(() => value as Promise<PluginRegistration>);
    return Effect.succeed(value);
  }).pipe(
    Effect.catchCause((cause) =>
      // A clean host shutdown interrupts the activation fiber mid-register();
      // let that interruption propagate instead of persisting a spurious
      // "failed" registration error. Use causeContainsInterrupt (hasInterrupts),
      // not hasInterruptsOnly: when the interrupt races a failing finalizer the
      // cause carries BOTH an interrupt and a defect, and hasInterruptsOnly would
      // return false — swallowing the shutdown signal into a persisted failure.
      causeContainsInterrupt(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(
            new PluginRegistrationError({
              pluginId,
              detail: Cause.pretty(cause),
            }),
          ),
    ),
  );

function validateRegistration(
  pluginId: PluginId,
  registration: PluginRegistration,
  capabilities: ReadonlyArray<PluginManifest["capabilities"][number]>,
): Effect.Effect<void, PluginRegistrationError> {
  // Plugin modules are dynamically loaded JS, so the SDK's `"read" | "operate"`
  // scope type is NOT enforced at runtime. Validate rpc AND streams identically
  // here: an out-of-whitelist scope (e.g. a typo/casing like "Operate") must be
  // rejected at registration rather than silently fall through to the weaker
  // read requirement in the dispatcher.
  const rpcMethods = new Set<string>();
  for (const rpc of registration.rpc ?? []) {
    if (rpc.scope !== "read" && rpc.scope !== "operate") {
      return Effect.fail(
        new PluginRegistrationError({ pluginId, detail: `invalid RPC scope ${rpc.scope}` }),
      );
    }
    // Modules are dynamically loaded JS, so the SDK's `handler` type is NOT
    // enforced at runtime: a descriptor with `handler: undefined` (or any
    // non-function) would otherwise activate and only defect at `handler(...)`
    // on the first matching call. Reject it here, mirroring the http check below.
    if (typeof rpc.handler !== "function") {
      return Effect.fail(
        new PluginRegistrationError({
          pluginId,
          detail: `RPC handler for ${rpc.method} is not a function`,
        }),
      );
    }
    if (rpcMethods.has(rpc.method)) {
      return Effect.fail(
        new PluginRegistrationError({ pluginId, detail: `duplicate RPC method ${rpc.method}` }),
      );
    }
    rpcMethods.add(rpc.method);
  }
  const streamMethods = new Set<string>();
  for (const stream of registration.streams ?? []) {
    if (stream.scope !== "read" && stream.scope !== "operate") {
      return Effect.fail(
        new PluginRegistrationError({ pluginId, detail: `invalid stream scope ${stream.scope}` }),
      );
    }
    if (typeof stream.handler !== "function") {
      return Effect.fail(
        new PluginRegistrationError({
          pluginId,
          detail: `stream handler for ${stream.method} is not a function`,
        }),
      );
    }
    if (streamMethods.has(stream.method)) {
      return Effect.fail(
        new PluginRegistrationError({
          pluginId,
          detail: `duplicate stream method ${stream.method}`,
        }),
      );
    }
    streamMethods.add(stream.method);
  }
  // Tools require the dedicated "tools" capability (capability-level consent).
  // Full descriptor validation + fingerprint reserve happen via PluginToolCatalog
  // before any irreversible McpServer.addTool.
  if ((registration.tools?.length ?? 0) > 0 && !capabilities.includes("tools")) {
    return Effect.fail(
      new PluginRegistrationError({
        pluginId,
        detail: 'plugin declares tools but does not include the "tools" capability',
      }),
    );
  }
  // Context contributions require the dedicated "context" capability. This grants
  // influence over what the agent DOES, so consent is not optional.
  if ((registration.context?.length ?? 0) > 0 && !capabilities.includes("context")) {
    return Effect.fail(
      new PluginRegistrationError({
        pluginId,
        detail:
          'plugin declares context contributions but does not include the "context" capability',
      }),
    );
  }
  // Provider drivers require the dedicated "providers" capability: a plugin provider
  // receives whatever the user sends to a thread using it.
  if ((registration.providers?.length ?? 0) > 0 && !capabilities.includes("providers")) {
    return Effect.fail(
      new PluginRegistrationError({
        pluginId,
        detail: 'plugin declares providers but does not include the "providers" capability',
      }),
    );
  }
  // Policy hooks require the dedicated "policy" capability. A hook can only DENY, so
  // this grants the ability to block the agent — never to approve for the user.
  if ((registration.policy?.length ?? 0) > 0 && !capabilities.includes("policy")) {
    return Effect.fail(
      new PluginRegistrationError({
        pluginId,
        detail: 'plugin declares policy hooks but does not include the "policy" capability',
      }),
    );
  }
  // HTTP routes require the dedicated "http" capability. Without this pairing check
  // a plugin that declares routes but omits the capability has them SILENTLY dropped
  // at the put site (which is gated on the capability), so the author sees routes
  // that never register and no error saying why. Fail loudly here instead, mirroring
  // the other capability-pairing checks above.
  if ((registration.http?.length ?? 0) > 0 && !capabilities.includes("http")) {
    return Effect.fail(
      new PluginRegistrationError({
        pluginId,
        detail: 'plugin declares http routes but does not include the "http" capability',
      }),
    );
  }
  // Validate each descriptor at registration rather than letting a malformed route
  // reach the http registry. Modules are dynamically loaded JS, so the SDK's field
  // types are NOT enforced at runtime: `auth` gates request authentication, so an
  // out-of-whitelist value must be rejected here rather than fall through to a weaker
  // default; `method`/`path` are matched literally, so an empty one would silently
  // never match; a non-function `handler` would defect on the first request.
  for (const descriptor of registration.http ?? []) {
    if (descriptor.auth !== "public" && descriptor.auth !== "token") {
      return Effect.fail(
        new PluginRegistrationError({ pluginId, detail: `invalid http auth ${descriptor.auth}` }),
      );
    }
    if (typeof descriptor.method !== "string" || descriptor.method.length === 0) {
      return Effect.fail(
        new PluginRegistrationError({ pluginId, detail: "http descriptor has an empty method" }),
      );
    }
    if (typeof descriptor.path !== "string" || descriptor.path.length === 0) {
      return Effect.fail(
        new PluginRegistrationError({ pluginId, detail: "http descriptor has an empty path" }),
      );
    }
    if (typeof descriptor.handler !== "function") {
      return Effect.fail(
        new PluginRegistrationError({
          pluginId,
          detail: "http descriptor handler is not a function",
        }),
      );
    }
  }
  for (const descriptor of registration.context ?? []) {
    // Reject an oversized STATIC contribution HERE, at activation, rather than
    // dropping it silently on every turn — the author would never find out.
    const violation = findContextDescriptorViolation(descriptor);
    if (violation !== null) {
      return Effect.fail(new PluginRegistrationError({ pluginId, detail: violation }));
    }
  }
  return Effect.void;
}

const unavailable = (capability: string) =>
  // Typed failure (not a defect) so a plugin that calls an undeclared capability
  // can catch/degrade gracefully instead of crashing the call as a defect.
  Effect.fail(new PluginCapabilityUnavailable({ capability }));

/**
 * Rejects a settings descriptor the host cannot honour, BEFORE any capability is
 * reachable and before the plugin is registered.
 *
 * Fail-closed at registration rather than at render time: an unrenderable field
 * would be drawn as a text box, read back as "", and produce writes that fail
 * validation forever — a silent, permanent breakage with no obvious cause. An
 * immediate typed error names the offending fields instead.
 */
const validateSettingsDescriptor = (
  pluginId: PluginId,
  settings: PluginSettingsDescriptor | undefined,
  capabilities: ReadonlyArray<PluginManifest["capabilities"][number]>,
  hasWebEntry: boolean,
): Effect.Effect<void, PluginRegistrationError> => {
  if (settings === undefined) {
    return Effect.void;
  }
  if (!hasWebEntry) {
    // The settings page is HOST-rendered into the plugin's web surface, so a plugin
    // with no web entry has no way for anyone to fill its settings in. If any field
    // is required this is immediately fatal (every read fails, unfixably); even when
    // everything is defaulted the declaration is inert. Reject it as a mistake
    // rather than ship a plugin whose settings can never be configured.
    return Effect.fail(
      new PluginRegistrationError({
        pluginId,
        detail:
          "declares settings but has no `web` manifest entry, so the host has no surface on which to render the settings page and the values could never be configured",
      }),
    );
  }
  if (!capabilities.includes("settings")) {
    return Effect.fail(
      new PluginRegistrationError({
        pluginId,
        detail:
          'declares settings but does not request the "settings" capability; add it to the manifest so the user consents to it',
      }),
    );
  }
  const violations = findPluginSettingsSchemaViolations(
    settings.schema as unknown as Parameters<typeof findPluginSettingsSchemaViolations>[0],
    { allowPasswordControl: false },
  );
  if (violations.length > 0) {
    return Effect.fail(
      new PluginRegistrationError({
        pluginId,
        detail: `settings schema is not renderable: ${violations
          .map((violation) => `${violation.field} ${violation.reason}`)
          .join("; ")}`,
      }),
    );
  }
  return Effect.void;
};

const makeHostApi = (input: {
  readonly pluginId: PluginId;
  readonly capabilities: ReadonlyArray<PluginManifest["capabilities"][number]>;
  readonly dataDir: string;
  readonly logger: PluginLogger;
  readonly grants: PluginWorkspaceGrants;
  /** Declared on the plugin's definition; absent when it declares no settings. */
  readonly settings: PluginSettingsDescriptor | undefined;
  readonly deps: {
    readonly sql: SqlClient.SqlClient;
    readonly secretStore: ServerSecretStore.ServerSecretStore["Service"];
    readonly config: ServerConfig.ServerConfig["Service"];
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly environment: ServerEnvironment.ServerEnvironment["Service"];
    readonly orchestrationEngine: OrchestrationEngine.OrchestrationEngineService["Service"];
    readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    readonly turns: ProjectionTurns.ProjectionTurnRepository["Service"];
    readonly messages: ProjectionThreadMessages.ProjectionThreadMessageRepository["Service"];
    readonly activities: ProjectionThreadActivities.ProjectionThreadActivityRepository["Service"];
    readonly providerInstances: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
    readonly git: GitVcsDriver.GitVcsDriver["Service"];
    readonly checkpointStore: CheckpointStore.CheckpointStore["Service"];
    readonly textGeneration: TextGeneration.TextGeneration["Service"];
    readonly sourceControlRegistry: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];
    readonly github: GitHubCli.GitHubCli["Service"];
    readonly terminals: TerminalManager.TerminalManager["Service"];
    readonly outboundLookup: OutboundUrlLookup["Service"];
    readonly httpClientTransport: PluginHttpClientTransportService["Service"];
    readonly settingsStore: PluginSettingsStore["Service"];
  };
}): { readonly api: PluginHostApi; readonly teardown: ReadonlyArray<Effect.Effect<void>> } => {
  const capabilities = new Set(input.capabilities);
  const available = <A>(capability: PluginManifest["capabilities"][number], value: A) =>
    capabilities.has(capability) ? Effect.succeed(value) : unavailable(capability);

  const terminalsBundle = makeTerminalsCapability({
    pluginId: input.pluginId,
    manager: input.deps.terminals,
  });
  const teardown: Array<Effect.Effect<void>> = [];
  if (capabilities.has("terminals")) {
    teardown.push(terminalsBundle.shutdown);
  }

  // Decoded reads for plugin code. Distinct from the web draft path on purpose:
  // the browser must be able to open the form on data that will not decode (that
  // is precisely when it needs repairing), whereas plugin code must never receive
  // config it cannot trust — it gets a typed failure instead.
  const settingsCapability = (
    descriptor: PluginSettingsDescriptor,
  ): SettingsCapability<Schema.Struct<Schema.Struct.Fields>> => {
    const decode = Schema.decodeUnknownEffect(descriptor.schema);
    const currentFingerprint = fingerprintSettingsSchema(
      descriptor.schema as unknown as Parameters<typeof fingerprintSettingsSchema>[0],
    );
    const read = Effect.gen(function* () {
      const draft = yield* input.deps.settingsStore.readDraft(input.pluginId);

      // NEVER hand a plugin defaults derived from unreadable storage.
      //
      // readDraft deliberately never fails — the WEB form must open on corrupt data
      // so the user can repair it. But that means a corrupt row, or ANY SQL read
      // failure, arrives here as an empty draft; decoding `{}` against a schema with
      // defaulted fields would then hand the plugin those defaults as if they were
      // the user's configuration. A plugin acting on "defaults" during a database
      // failure is worse than a plugin that fails loudly.
      if (draft.incompatible) {
        return yield* Effect.fail({
          _tag: "PluginSettingsInvalidStored" as const,
          pluginId: input.pluginId,
          message: `Plugin ${input.pluginId} settings could not be read from storage.`,
        });
      }

      // Reject drift EXPLICITLY rather than relying on decode to notice.
      //
      // Decode catches an incompatible shape in the common case, but not always: a
      // schema change that only widens (adds an optional field, relaxes a filter)
      // still decodes cleanly, so the plugin would silently run on values written
      // for a shape it no longer declares. The fingerprint makes the mismatch the
      // fact being checked instead of a side effect of decoding.
      if (draft.schemaFingerprint !== null && draft.schemaFingerprint !== currentFingerprint) {
        yield* Effect.logDebug("plugin settings schema drift", {
          pluginId: input.pluginId,
          revision: draft.revision,
        });
        return yield* Effect.fail({
          _tag: "PluginSettingsInvalidStored" as const,
          pluginId: input.pluginId,
          message: `Plugin ${input.pluginId} stored settings were written for a different schema shape.`,
        });
      }

      return yield* decode(draft.values).pipe(
        Effect.mapError(() =>
          // Never surface the decode error's rendering: it embeds the offending
          // values, which would put plugin configuration into logs.
          draft.revision === 0
            ? {
                _tag: "PluginSettingsNotConfigured" as const,
                pluginId: input.pluginId,
                message: `Plugin ${input.pluginId} has no stored settings yet.`,
              }
            : {
                _tag: "PluginSettingsInvalidStored" as const,
                pluginId: input.pluginId,
                message: `Plugin ${input.pluginId} stored settings do not match its current schema.`,
              },
        ),
        Effect.tapError(() =>
          Effect.logDebug("plugin settings decode failed", {
            pluginId: input.pluginId,
            revision: draft.revision,
          }),
        ),
      );
    });
    return {
      get: read,
      // Recover PER EVENT, not per stream.
      //
      // `Stream.catchCause(() => Stream.empty)` terminates the WHOLE stream on the
      // first failed read, so one transient SQL blip (or a read during a drifted
      // window) would silently end the subscription — later writes still reach the
      // PubSub, but this subscriber never sees another one for the process
      // lifetime. Dropping the failed event and continuing keeps the contract
      // ("emits on every successful write") honest.
      changes: input.deps.settingsStore.changes(input.pluginId).pipe(
        // Emit 0 or 1 values per event, then flatten: a failed read contributes
        // nothing and the stream continues to the next write.
        Stream.mapEffect(() =>
          read.pipe(
            Effect.map((value) => [value]),
            Effect.catchCause((cause) =>
              Effect.logDebug("plugin settings changes: read failed, skipping event", {
                pluginId: input.pluginId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as([])),
            ),
          ),
        ),
        Stream.flatMap((values) => Stream.fromIterable(values)),
      ),
    };
  };

  const api: PluginHostApi = {
    hostApiVersion: HOST_API_VERSION,
    // Two independent gates, deliberately. `available()` checks the manifest
    // capability set (what the user consented to) exactly like every other
    // capability; the `undefined` branch covers a plugin that holds the capability
    // but declares no schema — there is nothing to bind a typed handle to. Neither
    // gate depends on validateSettingsDescriptor having run first, so a future path
    // that builds hostApi without it still cannot hand out unconsented settings.
    settings:
      input.settings === undefined
        ? unavailable("settings")
        : available("settings", settingsCapability(input.settings)),
    config: {
      appVersion: APP_VERSION,
      hostApiVersion: HOST_API_VERSION,
      dataDir: input.dataDir,
      logger: input.logger,
    },
    agents: available(
      "agents",
      makeAgentsCapability({
        pluginId: input.pluginId,
        engine: input.deps.orchestrationEngine,
        snapshots: input.deps.snapshots,
        turns: input.deps.turns,
        messages: input.deps.messages,
        providerInstances: input.deps.providerInstances,
      }),
    ),
    vcs: available(
      "vcs",
      makeVcsCapability({
        git: input.deps.git,
        checkpoints: input.deps.checkpointStore,
        snapshots: input.deps.snapshots,
        grants: input.grants,
        fileSystem: input.deps.fileSystem,
        path: input.deps.path,
        worktreesDir: input.deps.config.worktreesDir,
      }),
    ),
    events: available(
      "events",
      makeEventsCapability({
        pluginId: input.pluginId,
        logger: input.logger,
        events: input.deps.orchestrationEngine.streamDomainEvents,
      }),
    ),
    terminals: available("terminals", terminalsBundle.capability),
    database: available("database", makeDatabaseCapability(input.deps.sql)),
    projectionsRead: available(
      "projections.read",
      makeProjectionsReadCapability({
        snapshots: input.deps.snapshots,
        turns: input.deps.turns,
        messages: input.deps.messages,
        activities: input.deps.activities,
      }),
    ),
    environmentsRead: available(
      "environments.read",
      makeEnvironmentsReadCapability({
        environment: input.deps.environment,
        snapshots: input.deps.snapshots,
      }),
    ),
    secrets: available(
      "secrets",
      makeSecretsCapability({
        pluginId: input.pluginId,
        store: input.deps.secretStore,
        config: input.deps.config,
        fileSystem: input.deps.fileSystem,
        path: input.deps.path,
      }),
    ),
    http: available("http", makeHttpCapability(input.pluginId)),
    filesystem: available(
      "filesystem",
      makeFilesystemCapability({
        snapshots: input.deps.snapshots,
        grants: input.grants,
      }),
    ),
    httpClient: available(
      "httpClient",
      makeHttpClientCapability({
        lookup: input.deps.outboundLookup,
        transport: input.deps.httpClientTransport,
      }),
    ),
    sourceControl: available(
      "sourceControl",
      makeSourceControlCapability({
        registry: input.deps.sourceControlRegistry,
        github: input.deps.github,
        snapshots: input.deps.snapshots,
        grants: input.grants,
        fileSystem: input.deps.fileSystem,
        path: input.deps.path,
      }),
    ),
    textGeneration: available(
      "textGeneration",
      makeTextGenerationCapability(input.deps.textGeneration),
    ),
  };

  return { api, teardown };
};

const upgradeLockfileEntry = (
  entry: PluginLockfilePlugin,
  staged: NonNullable<PluginLockfilePlugin["staged"]>,
): PluginLockfilePlugin => ({
  version: staged.version,
  sha256: staged.sha256,
  sourceId: entry.sourceId,
  enabled: entry.enabled,
  // Match state to enabled: upgrading a DISABLED plugin must not resurrect it as
  // "active" (the UI would show Active with no runtime, and RPCs would 404). Only
  // an enabled plugin becomes active on promotion.
  state: entry.enabled ? "active" : "disabled",
  // Reset activation health for the new build. Carrying over the old version's
  // crashCount could immediately trip the repeated-crash safe mode on the first
  // startup of the upgrade, and its lastError would surface a stale failure the
  // new version never produced. activatingSince starts null; loadPlugin sets it
  // when the fresh activation begins.
  activation: { activatingSince: null, crashCount: 0 },
  installedAt: entry.installedAt,
  lastError: null,
});

const getLockfilePlugin = (lockfile: PluginLockfile, pluginId: PluginId) =>
  (lockfile.plugins as Readonly<Record<string, PluginLockfilePlugin | undefined>>)[pluginId];

const updateFailure = (
  store: PluginLockfileStore["Service"],
  pluginId: PluginId,
  message: string,
) =>
  store.updatePlugin(pluginId, ({ current }) =>
    Effect.succeed(
      current
        ? {
            ...current,
            // Only an in-flight activation ("active") should flip to "failed".
            // If the user concurrently disabled/uninstalled/upgraded the plugin
            // while it was activating, preserve that requested lifecycle state
            // rather than clobbering it with "failed".
            state: current.state === "active" ? "failed" : current.state,
            lastError: message,
            activation: {
              ...current.activation,
              activatingSince: null,
            },
          }
        : undefined,
    ),
  );

const startService = (input: {
  readonly pluginId: PluginId;
  readonly logger: PluginLogger;
  readonly service: PluginServiceDescriptor;
}) =>
  input.service.run({ pluginId: input.pluginId, logger: input.logger }).pipe(
    Effect.catchCause((cause) =>
      input.logger.error("plugin service failed; restarting", {
        service: input.service.name,
        cause: Cause.pretty(cause),
      }),
    ),
    // Exponential backoff capped at 30s so a flapping service keeps
    // retrying at a bounded cadence instead of backing off forever.
    Effect.repeat(
      Schedule.either(Schedule.exponential("250 millis"), Schedule.spaced("30 seconds")),
    ),
  );

export const make = Effect.fn("PluginHost.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* PluginLockfileStore;
  const loader = yield* PluginModuleLoader;
  const migrator = yield* PluginMigrator;
  const registry = yield* PluginRuntimeRegistry;
  const toolCatalog = yield* PluginToolCatalog;
  const settingsStore = yield* PluginSettingsStore;
  const httpRegistry = yield* PluginHttpRegistry;
  const contextComposer = yield* PluginContextComposer;
  const policyRegistry = yield* PluginPolicyRegistry;
  const clock = yield* Clock.Clock;
  const sql = yield* SqlClient.SqlClient;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const turns = yield* ProjectionTurns.ProjectionTurnRepository;
  const messages = yield* ProjectionThreadMessages.ProjectionThreadMessageRepository;
  const activities = yield* ProjectionThreadActivities.ProjectionThreadActivityRepository;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const sourceControlRegistry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const github = yield* GitHubCli.GitHubCli;
  const terminals = yield* TerminalManager.TerminalManager;
  const outboundLookup = yield* OutboundUrlLookup;
  const httpClientTransport = yield* PluginHttpClientTransportService;
  const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;

  // Per-pluginId single-flight for activation/deactivation. Two concurrent
  // activatePlugin(pluginId) calls would otherwise both observe an empty registry
  // and both run loadPlugin; the second registry.put overwrites the first runtime's
  // entry, orphaning its scope — the first runtime's forked services,
  // terminal-cleanup finalizers, and HTTP routes stay live but unreachable, and a
  // later deactivatePlugin only tears down the second. A per-plugin single-permit
  // semaphore, get-or-created atomically under a synchronized ref, serializes them
  // so the second caller's registry.get double-check short-circuits instead of
  // loading a second runtime.
  const activationLocks = yield* SynchronizedRef.make(
    HashMap.empty<PluginId, Semaphore.Semaphore>(),
  );
  const withPluginActivationLock = <A, E, R>(
    pluginId: PluginId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    SynchronizedRef.modifyEffect(activationLocks, (locks) => {
      const existing = HashMap.get(locks, pluginId);
      return Option.isSome(existing)
        ? Effect.succeed([existing.value, locks] as const)
        : Semaphore.make(1).pipe(
            Effect.map(
              (semaphore) => [semaphore, HashMap.set(locks, pluginId, semaphore)] as const,
            ),
          );
    }).pipe(Effect.flatMap((semaphore) => semaphore.withPermits(1)(effect)));

  const publishPluginStateChanged = (pluginId: PluginId, state: PluginState) =>
    lifecycleEvents
      .publish({
        version: 1,
        type: "plugins",
        payload: {
          kind: "plugin-state-changed",
          pluginId,
          state,
        },
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.asVoid);

  const markFailure = (pluginId: PluginId, message: string) =>
    updateFailure(store, pluginId, message).pipe(
      // Publish the state that was actually persisted: updateFailure preserves a
      // concurrently-requested lifecycle state (disabled/pending-remove/...)
      // instead of forcing "failed", so announce that rather than a stale
      // "failed".
      Effect.flatMap((lockfile) => {
        const state = getLockfilePlugin(lockfile, pluginId)?.state;
        return state === undefined ? Effect.void : publishPluginStateChanged(pluginId, state);
      }),
    );

  // Clear ONLY the in-flight activation marker, preserving state/crashCount/
  // lastError. Used after a clean interrupt/cancel teardown so reconcile on the
  // next start does not mistake the intentional cancellation for a crash (a
  // lingering activatingSince bumps crashCount and eventually forces "failed").
  const clearActivatingMarker = (pluginId: PluginId) =>
    store
      .updatePlugin(pluginId, ({ current }) =>
        Effect.succeed(
          current
            ? { ...current, activation: { ...current.activation, activatingSince: null } }
            : undefined,
        ),
      )
      .pipe(Effect.ignore);

  // Outer handler for a loadPlugin failure that escaped the activation-exit
  // block (setup errors, or a re-raised interrupt/cancel from that block).
  // Three dispositions, checked in order:
  //   - contains ANY interrupt (clean shutdown / scope close, even when mixed
  //     with the sentinel or a teardown error): re-raise the whole cause so it
  //     keeps propagating and the host stops promptly.
  //   - EXCLUSIVELY the activation-cancel sentinel (concurrent disable/uninstall
  //     aborted the activation): benign — the teardown already ran and the marker
  //     was cleared, so just log and swallow, leaving the persisted state intact.
  //   - anything else (a genuine error, INCLUDING the sentinel combined with a
  //     real teardown/finalizer error): persist "failed" and log.
  const handleLoadFailureCause = (
    pluginId: PluginId,
    logMessage: string,
    cause: Cause.Cause<unknown>,
  ) =>
    causeContainsInterrupt(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : causeIsActivationCanceledOnly(cause)
        ? Effect.logWarning("Plugin activation canceled", {
            pluginId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.ignore)
        : markFailure(pluginId, Cause.pretty(cause)).pipe(
            Effect.andThen(Effect.logWarning(logMessage, { pluginId, cause: Cause.pretty(cause) })),
            Effect.ignore,
          );

  const readManifest = (pluginDir: string) =>
    fs
      .readFileString(pluginManifestPath(pluginDir, path.join))
      .pipe(Effect.flatMap(decodeManifest));

  const loadPlugin = (pluginId: PluginId, entry: PluginLockfilePlugin) =>
    Effect.gen(function* () {
      const pluginDir = pluginVersionDir(config.pluginsDir, pluginId, entry.version, path.join);
      const manifest = yield* readManifest(pluginDir);
      if (manifest.id !== pluginId) {
        return yield* new PluginRegistrationError({
          pluginId,
          detail: `manifest id ${manifest.id} does not match lockfile id`,
        });
      }
      // The plugin is loaded from the lockfile version's directory, so a manifest
      // whose version disagrees with the lockfile entry means the staged bytes do
      // not match the recorded install: runtime/catalog state would report a
      // different version than the lockfile/upgrade state, and migrations (keyed
      // only by plugin id) would run against ambiguous provenance. Reject it.
      if (manifest.version !== entry.version) {
        return yield* new PluginRegistrationError({
          pluginId,
          detail: `manifest version ${manifest.version} does not match lockfile version ${entry.version}`,
        });
      }
      if (!hostApiSatisfies(manifest.hostApi, HOST_API_VERSION)) {
        yield* store
          .updatePlugin(pluginId, ({ current }) =>
            Effect.succeed(current ? { ...current, state: "disabled-by-host" } : undefined),
          )
          .pipe(Effect.tap(() => publishPluginStateChanged(pluginId, "disabled-by-host")));
        yield* Effect.logWarning("Plugin disabled by host API version mismatch", {
          pluginId,
          requested: manifest.hostApi,
          hostApiVersion: HOST_API_VERSION,
        });
        return;
      }
      if (!manifest.entries.server) {
        yield* Effect.logDebug("Skipping web-only plugin in server plugin host", { pluginId });
        return;
      }

      const serverEntry = manifest.entries.server;
      const serverEntryPath = path.join(pluginDir, serverEntry);
      if (!(yield* fs.exists(pluginDir)) || !(yield* fs.exists(serverEntryPath))) {
        yield* markFailure(pluginId, "plugin directory or server entry is missing");
        return;
      }

      const activatingSince = DateTime.formatIso(yield* DateTime.now);
      // Persist the activating marker and acquire the interruptible setup resources
      // under ONE interrupt guard. An external shutdown interrupt landing between the
      // marker write and the uninterruptibleMask below (during Scope.make /
      // Deferred.make / makePluginWorkspaceGrants, all interruptible) re-raises via
      // handleLoadFailureCause WITHOUT the mask's exit ladder ever running — stranding
      // `activatingSince` so the next start miscounts a clean shutdown as an activation
      // crash and eventually forces the plugin to "failed". onInterrupt clears the
      // marker on any such pre-ladder interrupt (idempotent with the ladder's own
      // clear once activation is actually running).
      const { scope, readiness, grants } = yield* Effect.gen(function* () {
        yield* store.updatePlugin(pluginId, ({ current }) =>
          Effect.succeed(
            current
              ? {
                  ...current,
                  activation: {
                    ...current.activation,
                    activatingSince,
                  },
                }
              : undefined,
          ),
        );
        const scope = yield* Scope.make("sequential");
        const readiness = yield* Deferred.make<void>();
        const grants = yield* makePluginWorkspaceGrants;
        return { scope, readiness, grants };
      }).pipe(Effect.onInterrupt(() => clearActivatingMarker(pluginId)));
      const logger = makePluginLogger(pluginId);
      const dataDir = pluginDataDir(config.pluginsDir, pluginId, path.join);
      const makeHostApiForDefinition = (settings: PluginSettingsDescriptor | undefined) =>
        makeHostApi({
          pluginId,
          capabilities: manifest.capabilities,
          dataDir,
          logger,
          grants,
          settings,
          deps: {
            sql,
            secretStore,
            config,
            fileSystem: fs,
            path,
            environment,
            orchestrationEngine,
            snapshots,
            turns,
            messages,
            activities,
            providerInstances,
            git,
            checkpointStore,
            textGeneration,
            sourceControlRegistry,
            github,
            terminals,
            outboundLookup,
            httpClientTransport,
            settingsStore,
          },
        });

      const activation = Effect.gen(function* () {
        yield* fs.makeDirectory(dataDir, { recursive: true });

        // Load the module BEFORE building hostApi: settings are declared on the
        // DEFINITION, and hostApi.settings must already be bound to that schema
        // when it is handed to register(). (A schema declared on the value that
        // register RETURNS could never bind the handle passed INTO it.)
        //
        // This does not weaken the teardown guarantee below. Module top-level is
        // plugin code, but it cannot reach any capability: capabilities are only
        // handed over via register(hostApi), which runs after the finalizers are
        // registered.
        const definition = yield* loader.loadServerEntry(pluginDir, serverEntry);
        // Declare the schema BEFORE register() can fail. If a plugin reads its
        // settings during register() and the stored row is unreadable, activation
        // fails and no runtime is ever put — so a settings RPC that resolved the
        // schema only from live runtimes would report "no settings declared" and the
        // repair UI would be unreachable exactly when it is needed.
        // VALIDATE before caching the declaration. Caching first meant a plugin that
        // fails validation — no `settings` capability, or no web surface to render the
        // form on — still populated the map and could serve settings RPCs for a schema
        // the host had just rejected. Validation does not depend on the cache, and the
        // repair path only needs the declaration once the schema itself is legal.
        yield* validateSettingsDescriptor(
          pluginId,
          definition.settings,
          manifest.capabilities,
          manifest.entries.web !== undefined,
        );
        if (definition.settings !== undefined) {
          yield* settingsStore.noteDeclaredSchema(pluginId, definition.settings.schema as never);
        } else {
          // The CURRENT definition declares no settings. Clear any declaration a
          // prior (schema-declaring) version left behind: this runs BEFORE register(),
          // so the stale entry is gone even when this reload's activation later fails —
          // otherwise the settings RPC would fall back to the old version's schema.
          yield* settingsStore.clearDeclaredSchema(pluginId);
        }
        const { api: hostApi, teardown: hostApiTeardown } = makeHostApiForDefinition(
          definition.settings,
        );

        // Register capability teardowns (e.g. killing leaked terminals) on the
        // plugin scope before any capability is reachable, so cleanup fires on
        // EVERY exit path — activation failure, stop, disable, crash.
        for (const teardown of hostApiTeardown) {
          yield* Scope.addFinalizer(scope, teardown);
        }

        const registration = yield* resolveRegistration(pluginId, definition, hostApi).pipe(
          Effect.timeout(registrationTimeout()),
        );
        yield* validateRegistration(pluginId, registration, manifest.capabilities);
        // Always reserve (including empty tool sets) so descriptor-set removals
        // are rejected as restart-required before registry.put. Ownership/
        // fingerprint checks run before any irreversible MCP addTool.
        yield* toolCatalog
          .reserve(pluginId, registration.tools, {
            hasToolsCapability: manifest.capabilities.includes("tools"),
          })
          .pipe(
            Effect.mapError(
              (error: PluginToolCatalogError) =>
                new PluginRegistrationError({ pluginId, detail: error.detail }),
            ),
          );
        yield* migrator.run(pluginId, registration.migrations ?? []);
        if (registration.recover) {
          yield* registration.recover().pipe(Effect.timeout(registrationTimeout()));
        }
        if (manifest.capabilities.includes("http") && (registration.http?.length ?? 0) > 0) {
          // put + addFinalizer must be ATOMIC. Activation runs interruptible (inside
          // restore(...) below, by design), so a host-shutdown interrupt landing
          // BETWEEN the put and its finalizer would close the scope without ever
          // registering the removal — leaving this plugin's HTTP route live in the
          // host though the plugin never finished activating. The outer failure
          // ladder unconditionally clears registry/toolCatalog but NOT these three,
          // so the pairing is the only thing keeping them symmetric. uninterruptible
          // guarantees the finalizer is registered whenever the put took effect; the
          // interrupt stays pending and is delivered once the region is left.
          yield* Effect.uninterruptible(
            httpRegistry
              .put(pluginId, registration.http ?? [])
              .pipe(Effect.andThen(Scope.addFinalizer(scope, httpRegistry.remove(pluginId)))),
          );
        }
        if ((registration.policy?.length ?? 0) > 0) {
          // Removed on every exit path via the plugin scope. A disabled plugin that
          // kept blocking the agent would be a disabled plugin that is still running
          // — and the user would have no way to tell what was stopping their work.
          // Atomic with its finalizer (see the http pairing above) so an interrupt
          // in the window cannot leave the deny-policy hook live in the host.
          yield* Effect.uninterruptible(
            policyRegistry
              .put(pluginId, registration.policy ?? [])
              .pipe(Effect.andThen(Scope.addFinalizer(scope, policyRegistry.remove(pluginId)))),
          );
        }
        if ((registration.context?.length ?? 0) > 0) {
          // Removed on EVERY exit path via the plugin scope — disable, uninstall,
          // crash. A disabled plugin must stop steering the agent immediately;
          // leaving its instructions in place would be the plugin still running.
          // Atomic with its finalizer (see the http pairing above) so an interrupt
          // in the window cannot leave the context contribution live in the host.
          yield* Effect.uninterruptible(
            contextComposer
              .put(pluginId, registration.context ?? [])
              .pipe(Effect.andThen(Scope.addFinalizer(scope, contextComposer.remove(pluginId)))),
          );
        }
        // Re-check lifecycle state right before publishing the runtime. A
        // concurrent disable/uninstall flips the lockfile and runs
        // deactivatePlugin, which finds no runtime yet (we have not put it) and
        // returns early. Without this guard activation would finish and the
        // now-disabled/pending-remove plugin's runtime + services + HTTP routes
        // would go live anyway. Abort via the typed cancel sentinel (NOT a fiber
        // interrupt) so the failure branch closes the scope (removing any partial
        // HTTP registration), skips the registry.put + "active" publish, clears
        // the activating marker, and leaves the persisted state intact — while
        // staying distinguishable from a genuine host-shutdown interruption.
        // A read/parse failure here must NOT be swallowed as `undefined`: doing so
        // reads as "plugin missing", cancels activation via the benign sentinel, and
        // leaves the lockfile enabled+active with NO runtime until restart. Let the
        // error propagate to the activation-exit failure ladder, which marks the
        // plugin "failed" (matching activatePluginLocked's deliberate propagate at the
        // readLockfile there). readLockfile already returns an empty lockfile for a
        // missing FILE, so only true read/parse errors reach here; a genuinely-missing
        // ENTRY still yields `undefined` → the cancel sentinel below.
        const stateBeforePut = yield* store.readLockfile.pipe(
          Effect.map((current) => getLockfilePlugin(current, pluginId)?.state),
        );
        if (stateBeforePut !== "active") {
          return yield* new PluginActivationCanceled({
            pluginId,
            reason: `lifecycle state changed to ${stateBeforePut ?? "missing"} during activation`,
          });
        }
        yield* registry.put(pluginId, {
          manifest,
          registration,
          settings: definition.settings,
          readiness,
          scope,
        });
        // Re-check AFTER put under the activation lock. If disable already flipped
        // the lockfile, undo the put and deactivate so we do not leave a live
        // runtime for a non-active lifecycle. This does NOT alone close the
        // disable∩activation race: a put subscriber can still run catalog.activate
        // before disable acquires the lock. That race is closed by disable intent
        // (noteDisableIntent before the lock wait; activate refuses while set).
        // As with the pre-put read above, a read/parse failure here propagates to the
        // failure ladder (→ "failed") instead of being misread as "plugin missing".
        const stateAfterPut = yield* store.readLockfile.pipe(
          Effect.map((current) => getLockfilePlugin(current, pluginId)?.state),
        );
        if (stateAfterPut !== "active") {
          yield* registry.remove(pluginId);
          yield* toolCatalog.deactivate(pluginId);
          return yield* new PluginActivationCanceled({
            pluginId,
            reason: `lifecycle state changed to ${stateAfterPut ?? "missing"} during activation`,
          });
        }
        for (const service of registration.services ?? []) {
          yield* startService({ pluginId, logger, service }).pipe(
            Effect.forkScoped,
            Scope.provide(scope),
          );
        }
        yield* Deferred.succeed(readiness, undefined).pipe(Effect.orDie);
        // Clear activatingSince immediately on successful activation. Activation
        // has COMPLETED, so the plugin is no longer "activating"; leaving the
        // marker set until the delayed healthy-clear fires would make an
        // unrelated process restart within the stability window look like an
        // interrupted activation, wrongly incrementing crashCount and eventually
        // failing a healthy plugin. crashCount is still only forgiven (reset to
        // 0) after the stability window, so genuine activation-time crash loops
        // keep accumulating across restarts.
        const markActivated = (forgiveCrashes: boolean) =>
          store.updatePlugin(pluginId, ({ current }) =>
            Effect.succeed(
              current
                ? {
                    ...current,
                    activation: {
                      activatingSince: null,
                      crashCount: forgiveCrashes ? 0 : current.activation.crashCount,
                    },
                    lastError: null,
                  }
                : undefined,
            ),
          );
        yield* markActivated(false);
        const healthyDelay = healthyActivationDelay();
        if (Duration.toMillis(healthyDelay) === 0) {
          yield* markActivated(true);
        } else {
          yield* clock.sleep(healthyDelay).pipe(
            Effect.flatMap(() => markActivated(true)),
            Effect.ignoreCause({ log: true }),
            Effect.forkScoped,
            Scope.provide(scope),
          );
        }
      });

      // effect@4.0.0-beta.78's `exitFailCause` evaluator skips EVERY `contE`
      // continuation while an EXTERNAL fiber interrupt is pending and the fiber is
      // interruptible (internal/core.ts: `while (fiber.interruptible &&
      // fiber._interruptedCause && cont)`). `Effect.exit` is a plain contE/contA
      // primitive with no `contAll`, so a real host-shutdown interrupt of a
      // still-interruptible `activation` would unwind straight past this capture:
      // the exit ladder below (Scope.close terminal-teardown + httpRegistry.remove
      // finalizers, registry.remove, clearActivatingMarker) would never run,
      // leaking service fibers/terminals into a never-closed detached scope and
      // stranding `activatingSince` so reconcile phantom-crashes a healthy plugin.
      // (Internal interrupts — Effect.interrupt, Effect.timeout's child — are
      // captured fine, which is all the older tests covered.) Running the capture +
      // ladder inside `uninterruptibleMask` (with `restore` keeping `activation`
      // itself interruptible so shutdown still stops register()/services promptly)
      // makes the teardown fire on external interrupt too, and the interrupt still
      // propagates once the mask is left because it stays pending.
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* restore(activation.pipe(Scope.provide(scope))).pipe(Effect.exit);
          if (Exit.isFailure(exit)) {
            yield* Scope.close(scope, exit);
            // Activation may have already inserted the runtime into the registry
            // (registry.put runs mid-activation, before later steps). On failure the
            // scope is now closed, so drop the stale entry — otherwise registry.get
            // and registry.list keep reporting the plugin as active with a dead
            // scope and an unresolved readiness Deferred.
            yield* registry.remove(pluginId).pipe(Effect.ignore);
            yield* toolCatalog.deactivate(pluginId).pipe(Effect.ignore);
            if (causeContainsInterrupt(exit.cause)) {
              // ANY interruption (a clean host shutdown / scope close / stop), even
              // when mixed with the cancel sentinel or a teardown error. The teardown
              // above already ran, so this is NOT a crash — clear the activating
              // marker so reconcile on the next start does not miscount it, then
              // re-raise the whole cause so the persisted lifecycle state stays intact
              // and the host stops promptly.
              yield* clearActivatingMarker(pluginId);
              return yield* Effect.failCause(exit.cause as Cause.Cause<never>);
            }
            if (causeIsActivationCanceledOnly(exit.cause)) {
              // EXCLUSIVELY the cancel sentinel: a concurrent disable/uninstall
              // cancelled this activation via the pre-put re-check. The teardown above
              // already ran (not a crash) — clear the activating marker and re-raise
              // the typed sentinel so callers can tell it apart from a genuine error
              // (do NOT mark "failed") and from a shutdown interrupt (handled above).
              yield* clearActivatingMarker(pluginId);
              return yield* Effect.failCause(exit.cause as Cause.Cause<never>);
            }
            // Genuine error — INCLUDING the sentinel combined with a real teardown/
            // finalizer error/defect. Do NOT drop it: persist "failed".
            const message = Cause.pretty(exit.cause);
            yield* markFailure(pluginId, message);
            yield* Effect.logWarning("Plugin activation failed", { pluginId, cause: message });
            return;
          }
          // Announce the state actually persisted, not a hardcoded "active", so a
          // concurrent disable/uninstall (which flips the lockfile and runs
          // deactivatePlugin after registry.put but before this publish) isn't
          // contradicted.
          const persistedState = yield* store.readLockfile.pipe(
            Effect.map((lockfile) => getLockfilePlugin(lockfile, pluginId)?.state ?? "active"),
            Effect.orElseSucceed(() => "active" as PluginState),
          );
          yield* publishPluginStateChanged(pluginId, persistedState);
        }),
      );
    });

  // Body of activatePlugin WITHOUT acquiring the activation lock. The caller MUST
  // already hold it. Split out so setPluginEnabled can persist the lockfile and
  // activate under a SINGLE acquisition — withPluginActivationLock is a
  // Semaphore(1) and is NOT reentrant, so calling activatePlugin from inside the
  // lock would deadlock.
  const activatePluginLocked = (pluginId: PluginId) =>
    Effect.gen(function* () {
      // Propagate a lockfile read/parse failure instead of substituting an empty
      // lockfile: an empty lockfile makes getLockfilePlugin return undefined and
      // the guard below no-op, so activatePlugin would SUCCEED without loading
      // anything and callers (PluginInstaller) would treat a failed
      // install/enable as done. A genuinely MISSING lockfile is already handled
      // inside readLockfile (it returns EMPTY_PLUGIN_LOCKFILE for a null read),
      // so this only surfaces real read/parse errors.
      const lockfile = yield* store.readLockfile;
      const entry = getLockfilePlugin(lockfile, pluginId);
      if (!entry?.enabled || entry.state !== "active") return;
      // Successful enable: clear disable intent even when a runtime is already
      // present (e.g. enable races a slow disable teardown). Intent must not
      // permanently block catalog.activate after the user re-enabled.
      yield* toolCatalog.clearDisableIntent(pluginId);
      const active = yield* registry.get(pluginId);
      if (Option.isSome(active)) {
        // Runtime survived; re-open catalog gates now that intent is cleared.
        yield* toolCatalog.activate(pluginId);
        return;
      }
      yield* loader.ensureHostSingletonResolution;
      yield* loadPlugin(pluginId, entry).pipe(
        Effect.catchCause((cause) =>
          handleLoadFailureCause(pluginId, "Plugin hot activation failed", cause),
        ),
      );
    });

  const activatePlugin: PluginHost["Service"]["activatePlugin"] = (pluginId) =>
    Effect.gen(function* () {
      if (process.env.T3_NO_PLUGINS === "1") {
        yield* Effect.logInfo("Plugin host disabled by T3_NO_PLUGINS", { pluginId });
        return;
      }
      // Single-flight per pluginId (see activationLocks): a second concurrent
      // activatePlugin waits for the first to finish, then its registry.get
      // double-check returns Some and short-circuits — no second loadPlugin, no
      // leaked runtime. The registry.get early-return stays INSIDE the lock.
      yield* withPluginActivationLock(pluginId, activatePluginLocked(pluginId));
    });

  // Signals disable intent and closes the catalog gates WITHOUT taking the lock.
  // MUST run before waiting on the activation lock. Ordering:
  //   1. noteDisableIntent — activate refuses to reopen while this is set
  //   2. deactivate — clears visibility/call active bindings immediately
  //   3. (caller) wait for activation lock, then remove runtime
  // Without (1), a registry.put subscriber queued before remove can still see a
  // live runtime and reopen active while we wait on the lock.
  // Idempotent: setPluginEnabled re-asserts it INSIDE the lock, because a
  // concurrent enable that wins the lock clears the intent and reopens the
  // catalog, which would otherwise leave the catalog active with no runtime.
  const signalDisableIntent = (pluginId: PluginId) =>
    Effect.gen(function* () {
      yield* toolCatalog.noteDisableIntent(pluginId);
      yield* toolCatalog.deactivate(pluginId);
    });

  // Body of deactivatePlugin WITHOUT acquiring the activation lock. The caller
  // MUST already hold it (see activatePluginLocked — the semaphore is not reentrant).
  const deactivatePluginLocked = (pluginId: PluginId) =>
    Effect.gen(function* () {
      const runtime = yield* registry.get(pluginId);
      if (Option.isSome(runtime)) {
        // Drop the runtime so registry.get fails closed, then interrupt
        // invocation fibers owned by the plugin scope (handlers forkIn that
        // scope). Scope.close does not by itself stop work still running only
        // on the MCP request fiber — ownership is required.
        yield* registry.remove(pluginId);
        yield* toolCatalog.deactivate(pluginId);
        yield* Scope.close(runtime.value.scope, Exit.void).pipe(Effect.ignore);
        yield* httpRegistry.remove(pluginId).pipe(Effect.ignore);
      }
      // Publish on BOTH paths, including when no runtime was present: disabling a
      // plugin that never activated (web-only, or one whose activation failed)
      // still persists "disabled"/"pending-remove", and subscribers + the UI would
      // otherwise stay stale until a later refresh or restart.
      //
      // Announce the state that is actually persisted rather than a hardcoded
      // "disabled": uninstall sets "pending-remove" then calls this, and
      // publishing "disabled" would contradict the lockfile + list APIs.
      const persistedState = yield* store.readLockfile.pipe(
        Effect.map((lockfile) => getLockfilePlugin(lockfile, pluginId)?.state ?? "disabled"),
        Effect.orElseSucceed(() => "disabled" as PluginState),
      );
      yield* publishPluginStateChanged(pluginId, persistedState);
    });

  const deactivatePlugin: PluginHost["Service"]["deactivatePlugin"] = (pluginId) =>
    Effect.gen(function* () {
      yield* signalDisableIntent(pluginId);
      yield* withPluginActivationLock(pluginId, deactivatePluginLocked(pluginId));
    });

  // Persist the enabled/disabled lockfile write AND the corresponding host action
  // under a SINGLE activation-lock acquisition.
  //
  // Why this exists: PluginInstaller.setEnabled used to persist first and only then
  // call activatePlugin/deactivatePlugin, which each took the lock separately. Two
  // concurrent setEnabled calls could interleave between the persist and the host
  // action: disable persisted "disabled"; a later enable persisted "active" and
  // returned reusing the live runtime; then the older disable removed that runtime.
  // Final state was lockfile enabled+active with NO runtime and disable intent stuck
  // set — a permanently broken plugin. Making persist+action atomic per plugin means
  // whichever call acquires the lock last determines a coherent final state.
  const setPluginEnabled: PluginHost["Service"]["setPluginEnabled"] = (
    pluginId,
    enabled,
    persist,
  ) =>
    Effect.gen(function* () {
      // Pre-lock intent still matters: it stops a registry.put subscriber queued
      // before removal from reopening the gates while we wait for the lock.
      if (!enabled) yield* signalDisableIntent(pluginId);
      return yield* withPluginActivationLock(
        pluginId,
        Effect.gen(function* () {
          if (enabled) {
            yield* persist;
            yield* activatePluginLocked(pluginId);
            return;
          }
          // signalDisableIntent (pre-lock) has closed the catalog gates and set the
          // disable intent but has NOT removed the runtime — that happens in
          // deactivatePluginLocked, after persist. So a live runtime here means the
          // plugin was active before this call.
          const wasActive = Option.isSome(yield* registry.get(pluginId));
          yield* persist.pipe(
            Effect.tapError(() =>
              // Persist failed, so nothing was persisted and the plugin is still
              // enabled+active. Roll back the pre-lock signalDisableIntent, or its
              // tools stay hidden and reactivation stays blocked. Condition on
              // wasActive: if the plugin was NOT active, the closed gates + intent
              // describe its real (already-disabled) state and must be left as-is —
              // and clearing intent then would wrongly reopen a disabled plugin.
              wasActive
                ? toolCatalog
                    .clearDisableIntent(pluginId)
                    .pipe(Effect.andThen(toolCatalog.activate(pluginId)))
                : Effect.void,
            ),
          );
          // Re-assert INSIDE the lock: a concurrent enable that won the lock first
          // cleared the intent and reopened the catalog, so the pre-lock signal is
          // no longer in effect. Without this, disable would remove the runtime and
          // leave the catalog active with no runtime behind it.
          yield* signalDisableIntent(pluginId);
          yield* deactivatePluginLocked(pluginId);
        }),
      );
    });

  const reconcilePendingState = (pluginId: PluginId, entry: PluginLockfilePlugin) =>
    Effect.gen(function* () {
      if (entry.state === "pending-remove") {
        const pluginRoot = path.join(config.pluginsDir, pluginId);
        const dataDir = pluginDataDir(config.pluginsDir, pluginId, path.join);
        const markerPath = path.join(pluginRoot, PRESERVE_DATA_MARKER);
        const exists = (target: string) =>
          fs.exists(target).pipe(Effect.orElseSucceed(() => false));
        // Deterministic (NOT timestamped) preserve path. A crash between the
        // rename-out and rename-back must be recoverable on the next start; a
        // per-attempt `.preserved-<id>-<millis>` path stranded the data forever
        // because a retry computed a fresh timestamp and never found the old dir.
        const preservedDataDir = path.join(
          config.pluginsDir,
          `${PRESERVED_DATA_DIR_PREFIX}${pluginId}`,
        );
        // A leftover preserved dir is proof a prior reconcile of THIS plugin
        // crashed after moving data aside — adopt it as the preserve intent even
        // if the marker (which lived inside the now-removed root) is already gone.
        const preservedAlready = yield* exists(preservedDataDir);
        const preserveData = preservedAlready || (yield* exists(markerPath));
        if (preserveData) {
          // Ordering is chosen so no crash window can lose data the user chose to
          // keep. (A) park the data OUTSIDE the plugin root; (B) delete the root
          // (destroying the in-root marker and version dirs); (C) recreate the empty
          // root as the rename-back target; (E) drop the lockfile entry; (D) re-home
          // the data LAST. removePlugin runs BEFORE the final rename-back so a crash
          // after it leaves the data safe (still at `.preserved-<id>`) but orphaned —
          // the start-time sweep re-homes it, since the entry is now gone. The old
          // order (rename-back, THEN removePlugin) left a window in which the data was
          // already back at its normal path with NO marker and NO preserved dir, so a
          // crash there made the next reconcile take the delete-data branch below and
          // destroy it.
          if (!preservedAlready && (yield* exists(dataDir))) {
            yield* fs.rename(dataDir, preservedDataDir); // A
          }
          yield* fs.remove(pluginRoot, { recursive: true, force: true }); // B
          const hasPreserved = yield* exists(preservedDataDir);
          if (hasPreserved) {
            yield* fs.makeDirectory(pluginRoot, { recursive: true }); // C
          }
          yield* store.removePlugin(pluginId); // E (before the rename-back)
          if (hasPreserved) {
            yield* fs.rename(preservedDataDir, dataDir); // D (last)
          }
          return false;
        }
        yield* fs.remove(pluginRoot, { recursive: true, force: true });
        // Settings live in the host DB, not under pluginRoot, so removing the
        // plugin directory does NOT remove them. Without this, "Remove plugin
        // data" then reinstalling the same id silently recovered the old config.
        yield* settingsStore.remove(pluginId);
        yield* store.removePlugin(pluginId);
        return false;
      }
      if (entry.state === "pending-upgrade") {
        if (!entry.staged) {
          yield* markFailure(pluginId, "pending upgrade is missing staged plugin metadata");
          return false;
        }
        const staged = entry.staged;
        yield* store
          .updatePlugin(pluginId, ({ current }) =>
            Effect.succeed(current ? upgradeLockfileEntry(current, staged) : undefined),
          )
          .pipe(Effect.tap(() => publishPluginStateChanged(pluginId, "active")));
        return true;
      }
      if (entry.activation.activatingSince !== null) {
        const crashCount = entry.activation.crashCount + 1;
        if (crashCount >= 2) {
          yield* store
            .updatePlugin(pluginId, ({ current }) =>
              Effect.succeed(
                current
                  ? {
                      ...current,
                      state: "failed",
                      lastError: "disabled after repeated crashes",
                      activation: { activatingSince: null, crashCount },
                    }
                  : undefined,
              ),
            )
            .pipe(Effect.tap(() => publishPluginStateChanged(pluginId, "failed")));
          return false;
        }
        yield* store.updatePlugin(pluginId, ({ current }) =>
          Effect.succeed(
            current
              ? {
                  ...current,
                  activation: { activatingSince: null, crashCount },
                }
              : undefined,
          ),
        );
      }
      return true;
    });

  // Re-home any orphaned preserved-data directory left by a crash in the narrow
  // window between removePlugin and the final rename-back in reconcilePendingState.
  // Such a `.preserved-<id>` holds data the user chose to keep but has NO lockfile
  // entry pointing at it, so the per-plugin reconcile loop (which iterates lockfile
  // entries) never visits it. Idempotent: an id that still has an entry is left for
  // the normal reconcile path; a `.preserved-<id>` whose destination data dir already
  // exists is left in place rather than overwritten, so no live data is clobbered.
  const sweepOrphanedPreservedData = (lockfile: PluginLockfile) =>
    Effect.gen(function* () {
      const entries = yield* fs
        .readDirectory(config.pluginsDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      for (const name of entries) {
        if (!name.startsWith(PRESERVED_DATA_DIR_PREFIX)) continue;
        const pluginId = name.slice(PRESERVED_DATA_DIR_PREFIX.length) as PluginId;
        if (pluginId.length === 0) continue;
        // The id is derived from an on-disk directory name and then joined into a
        // path we rename INTO. A hand-crafted dir like `.preserved-../../evil` would
        // otherwise escape pluginsDir via path.join and let the rename write outside
        // it. Only a syntactically valid plugin id (no separators, no `..`) can be a
        // real orphan, so reject anything else.
        if (!SWEEP_PLUGIN_ID_PATTERN.test(pluginId)) {
          yield* Effect.logWarning("Skipping preserved-data dir with an invalid plugin id", {
            name,
          });
          continue;
        }
        // A still-tracked id belongs to the pending-remove reconcile path, not the
        // sweep — only an orphan (entry already gone) is re-homed here.
        if (getLockfilePlugin(lockfile, pluginId) !== undefined) continue;
        const preservedDataDir = path.join(config.pluginsDir, name);
        const pluginRoot = path.join(config.pluginsDir, pluginId);
        const dataDir = pluginDataDir(config.pluginsDir, pluginId, path.join);
        const dataExists = yield* fs.exists(dataDir).pipe(Effect.orElseSucceed(() => false));
        if (dataExists) {
          // A data dir is already in place. Re-homing would have to overwrite it and
          // could destroy live data, so leave the preserved copy untouched for manual
          // recovery rather than clobber what is there.
          yield* Effect.logWarning(
            "Orphaned preserved plugin data left in place; a data directory already exists",
            { pluginId, preservedDataDir },
          );
          continue;
        }
        yield* fs.makeDirectory(pluginRoot, { recursive: true });
        yield* fs.rename(preservedDataDir, dataDir);
      }
    }).pipe(Effect.ignoreCause({ log: true }));

  const start = Effect.gen(function* () {
    if (process.env.T3_NO_PLUGINS === "1") {
      yield* Effect.logInfo("Plugin host disabled by T3_NO_PLUGINS");
      return;
    }
    if (!(yield* fs.exists(store.lockfilePath).pipe(Effect.orElseSucceed(() => false)))) {
      return;
    }
    yield* loader.ensureHostSingletonResolution;
    const lockfileResult = yield* store.readLockfile.pipe(
      Effect.map((lockfile) => ({ read: true as const, lockfile })),
      Effect.catch((error) =>
        Effect.logWarning("Plugin host could not read lockfile", {
          path: store.lockfilePath,
          error: error.message,
        }).pipe(
          Effect.as({
            read: false as const,
            lockfile: { plugins: {}, sources: [] } as PluginLockfile,
          }),
        ),
      ),
    );
    const lockfile = lockfileResult.lockfile;

    // Re-home orphaned preserved data BEFORE the reconcile loop. Orphans have no
    // lockfile entry, so the loop below never touches them; and reconcile only ever
    // REMOVES entries, so using the pre-reconcile lockfile here cannot misclassify a
    // still-tracked plugin as an orphan.
    //
    // But ONLY when the lockfile was actually read. On a read failure the substitute
    // empty lockfile has no entries, so a `.preserved-<id>` dir belonging to a real
    // pending-remove entry would look orphaned and get re-homed to `<id>/data` — then
    // the next start, seeing neither preserve marker nor preserved dir, takes the
    // delete-data branch and permanently destroys data the user chose to keep.
    if (lockfileResult.read) {
      yield* sweepOrphanedPreservedData(lockfile);
    }

    for (const [rawPluginId, entry] of Object.entries(lockfile.plugins)) {
      const pluginId = rawPluginId as PluginId;
      const shouldContinue = yield* reconcilePendingState(pluginId, entry).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Plugin pending-state reconciliation failed", {
            pluginId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      if (!shouldContinue || !entry.enabled) continue;
      const currentLockfile = yield* store.readLockfile.pipe(Effect.orElseSucceed(() => lockfile));
      const currentEntry = getLockfilePlugin(currentLockfile, pluginId);
      if (!currentEntry?.enabled || currentEntry.state !== "active") continue;
      // Route the start-loop activation through the SAME per-plugin single-flight
      // lock as activatePlugin, with a registry.get double-check inside it.
      // Commands are accepted before the host finishes starting, and
      // PluginInstaller.setEnabled/confirmInstall call host.activatePlugin on the
      // RPC fiber. Without this lock, an enable/install RPC racing the start loop
      // for the SAME plugin runs two concurrent loadPlugin: register() twice,
      // migrator.run twice (the second INSERT INTO plugin_migrations PK-conflicts →
      // spurious "failed"), and the second registry.put orphans the first runtime's
      // scope. The lock serializes them; the registry.get double-check
      // short-circuits the loser instead of loading a second runtime.
      yield* withPluginActivationLock(
        pluginId,
        Effect.gen(function* () {
          const active = yield* registry.get(pluginId);
          if (Option.isSome(active)) return;
          yield* loadPlugin(pluginId, currentEntry).pipe(
            Effect.catchCause((cause) =>
              // A pure per-plugin self-cancel (the pre-put state re-check firing the
              // typed PluginActivationCanceled sentinel, and ONLY that, for ONE
              // plugin) is benign: log and CONTINUE so the remaining plugins still
              // activate. Everything else goes through handleLoadFailureCause, which
              // RE-RAISES any interrupt-containing cause (host shutdown, even mixed
              // with the sentinel) — that propagates out of this loop so the trailing
              // Effect.ignoreCause ends start promptly instead of plodding through the
              // rest of the plugins during shutdown — and marks a real error
              // (including the sentinel combined with a teardown error) as "failed".
              causeIsActivationCanceledOnly(cause)
                ? Effect.logWarning("Plugin activation canceled during start; skipping", {
                    pluginId,
                    cause: Cause.pretty(cause),
                  })
                : handleLoadFailureCause(
                    pluginId,
                    "Plugin activation failed before scope acquisition",
                    cause,
                  ),
            ),
          );
        }),
      );
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  // Close every active plugin's runtime scope at host teardown. Each activation
  // creates a DETACHED scope (Scope.make in loadPlugin) that nothing else owns,
  // so without this a dev-restart / desktop reload / test teardown leaves the
  // service fibers, terminal-cleanup finalizers, and HTTP-route registrations of
  // still-active plugins leaked in-process. Registered as a layer-scope finalizer
  // (Layer.effect runs make in the layer's build scope), so it fires when the
  // server runtime is torn down. Direct scope close — not deactivatePlugin — to
  // avoid acquiring per-plugin locks or publishing lifecycle events while the
  // whole server is going down.
  yield* Effect.addFinalizer(() =>
    registry.list.pipe(
      Effect.flatMap((runtimes) =>
        Effect.forEach(
          runtimes,
          (runtime) => {
            const pluginId = runtime.manifest.id as PluginId;
            return Scope.close(runtime.scope, Exit.void).pipe(
              Effect.ignore,
              Effect.andThen(httpRegistry.remove(pluginId).pipe(Effect.ignore)),
              Effect.andThen(registry.remove(pluginId)),
            );
          },
          { concurrency: "unbounded", discard: true },
        ),
      ),
      Effect.ignore,
    ),
  );

  return PluginHost.of({ start, activatePlugin, deactivatePlugin, setPluginEnabled });
});

export const layer = Layer.effect(PluginHost, make());
