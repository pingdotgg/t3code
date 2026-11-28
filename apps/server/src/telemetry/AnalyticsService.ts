// T3 ingest retains events and deduplicates retries by UUID.
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isCiEnvironment, isDoNotTrackSet } from "@t3tools/shared/otelEnvironment";
import type { ClientOs } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { getTelemetryIdentity, type TelemetryOwner } from "./Identify.ts";

interface OwnerReservation {
  readonly key: string;
  readonly observedBy: "server" | "client";
  queued: boolean;
}

interface BufferedAnalyticsEvent {
  readonly uuid: string;
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
  /** Sent under its own id, without the install id, so it links to nothing else. */
  readonly anonymous?: true;
  readonly owner?: OwnerReservation;
}

interface DeliveryState {
  readonly failedBatch: ReadonlyArray<BufferedAnalyticsEvent>;
  readonly batchAttempts: number;
  readonly firstFailedAt: number;
  readonly failures: number;
  readonly retryAt: number;
}

// Retry delays shorter than this still wait for the next background check.
const FLUSH_INTERVAL_MS = 10_000;
// A hung send would hold the flush lock for the next background flush.
const SEND_TIMEOUT = "10 seconds";
// Quit and restart wait for this flush; events it cannot send in time are dropped.
const SHUTDOWN_FLUSH_TIMEOUT = "1 second";
// A failed batch is tried again until it has failed for this long. Ingest answers 503 when it
// cannot store a batch, and a broken Cloudflare location can take about 5 minutes to fail over.
// The waiting batch holds newer events back; `maxBufferedEvents` bounds them meanwhile.
const MAX_BATCH_RETRY_MS = 30 * 60_000;
const RETRY_BASE_DELAY_MS = 2_000;
// Clients can report any number of owner ids; past this many per observer, new ones
// are not sent. Each observer has its own cap, so client reports never crowd out the
// server's own.
const MAX_RECORDED_OWNERS = 1_000;
const RETRY_MAX_DELAY_MS = 300_000;
// These statuses reject the batch itself; unlike 408/429, retrying cannot help.
const REJECTED_BATCH_STATUSES = new Set([400, 401, 413]);

/** `random` is in [0, 1). */
function retryDelayMs(failures: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failures - 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

// Config.Boolean does not export its codec; launch and late shell flags share this schema.
const TelemetryTrueLiterals = Schema.Literals(["true", "yes", "on", "1", "y"]);
const TelemetryFalseLiterals = Schema.Literals(["false", "no", "off", "0", "n"]);
const TelemetryEnabledFlag = Schema.Union([
  TelemetryTrueLiterals.pipe(
    Schema.decodeTo(
      Schema.Literal(true),
      SchemaTransformation.transform<true, typeof TelemetryTrueLiterals.Type>({
        decode: () => true,
        encode: () => "true",
      }),
    ),
  ),
  TelemetryFalseLiterals.pipe(
    Schema.decodeTo(
      Schema.Literal(false),
      SchemaTransformation.transform<false, typeof TelemetryFalseLiterals.Type>({
        decode: () => false,
        encode: () => "false",
      }),
    ),
  ),
]);
const decodeTelemetryEnabledFlag = Schema.decodeUnknownOption(TelemetryEnabledFlag);

const TelemetryEnvConfig = Config.all({
  ingestKey: Config.String("T3CODE_TELEMETRY_KEY").pipe(
    Config.withDefault("phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m"),
  ),
  ingestHost: Config.String("T3CODE_TELEMETRY_HOST").pipe(
    Config.withDefault("https://ingest.t3.codes"),
  ),
  enabled: Config.schema(TelemetryEnabledFlag, "T3CODE_TELEMETRY_ENABLED").pipe(Config.option),
  flushBatchSize: Config.Number("T3CODE_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  maxBufferedEvents: Config.Number("T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
  wslDistroName: Config.String("WSL_DISTRO_NAME").pipe(Config.option),
});

// Users name or import their own distros, so only well-known families are reported.
const WSL_DISTRO_FAMILIES = [
  ["ubuntu", "Ubuntu"],
  ["debian", "Debian"],
  ["kali", "Kali"],
  ["opensuse", "openSUSE"],
  ["suse", "SUSE"],
  ["sles", "SUSE"],
  ["oraclelinux", "OracleLinux"],
  ["almalinux", "AlmaLinux"],
  ["rockylinux", "RockyLinux"],
  ["fedora", "Fedora"],
  ["archlinux", "Arch"],
  ["alpine", "Alpine"],
  ["nixos", "NixOS"],
  ["pengwin", "Pengwin"],
  ["docker-desktop", "docker-desktop"],
] as const;

export const wslDistroFamily = (distroName: string): string | undefined => {
  const name = distroName.trim().toLowerCase();
  if (name === "") return undefined;
  return WSL_DISTRO_FAMILIES.find(([prefix]) => name.startsWith(prefix))?.[1] ?? "other";
};

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Whether the event was queued to send; false when telemetry is off. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
      options?: { readonly anonymous?: boolean },
    ) => Effect.Effect<boolean>;

    readonly flush: Effect.Effect<void>;

    /**
     * Records `install.owner_observed` for each owner of this install that the
     * server read itself or a connecting client reported. Once delivery succeeds,
     * reconnects and repeated reads do not queue that owner again in this process.
     */
    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

function serverOsFromNodePlatform(platform: string): ClientOs {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "android":
      return "Android";
    default:
      return "other";
  }
}

/** @public */
/** @public */
export const make = Effect.gen(function* () {
  const telemetryConfig = yield* TelemetryEnvConfig;
  const hostEnvironment = yield* HostProcess.Environment;
  const awaitingShellConsent = hostEnvironment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING === "1";
  const enabledByDefault = !isCiEnvironment(hostEnvironment);
  // A managed policy can switch analytics off over the environment, never on.
  const policyAllows =
    ManagedPolicy.deniedBy(yield* ManagedPolicy.ManagedPolicy, "telemetry") === undefined;
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const identityContext = yield* Effect.context<Effect.Services<typeof getTelemetryIdentity>>();
  const identity = yield* Effect.cachedWithTTL(
    getTelemetryIdentity.pipe(Effect.provide(identityContext)),
    (exit) =>
      Exit.isSuccess(exit) && exit.value.distinctId !== null ? "Infinity" : FLUSH_INTERVAL_MS,
  );
  const crypto = yield* SecureRandom.SecureRandom;
  const makeQueue = () => ({
    buffer: [] as ReadonlyArray<BufferedAnalyticsEvent>,
    owners: {
      server: new Map<string, OwnerReservation>(),
      client: new Map<string, OwnerReservation>(),
    },
    delivery: {
      failedBatch: [],
      batchAttempts: 0,
      firstFailedAt: 0,
      failures: 0,
      retryAt: 0,
    } as DeliveryState,
  });
  let queue = makeQueue();
  const recordedOwners = { server: new Set<string>(), client: new Set<string>() };
  let settingsEnabled = true;
  // A cached PATH does not establish consent from the current login shell.
  const environmentOverride = () => {
    if (!awaitingShellConsent) return telemetryConfig.enabled;
    if (
      hostEnvironment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING === "1" ||
      Option.contains(telemetryConfig.enabled, false)
    )
      return Option.some(false);
    const preference = hostEnvironment.T3CODE_TELEMETRY_ENABLED;
    return preference === undefined || preference === ""
      ? telemetryConfig.enabled
      : Option.orElse(decodeTelemetryEnabledFlag(preference), () => Option.some(false));
  };
  let enabled = false;
  const applyEnabled = () => {
    const next =
      policyAllows &&
      !isDoNotTrackSet(hostEnvironment) &&
      Option.getOrElse(environmentOverride(), () => enabledByDefault && settingsEnabled);
    // Replacing the queue invalidates recordings and sends already in progress, including retries.
    if (enabled && !next) queue = makeQueue();
    enabled = next;
  };
  if (serverSettings.observeChanges) {
    yield* serverSettings.observeChanges((settings) => {
      settingsEnabled = settings.shareUsageData;
      applyEnabled();
    });
  }
  yield* serverSettings.withSettingsSnapshot((settings) =>
    Effect.sync(() => {
      settingsEnabled = settings.shareUsageData;
      applyEnabled();
    }),
  );
  const telemetryEnabled = Effect.sync(() => {
    applyEnabled();
    return enabled;
  });
  // The background flush and the shutdown flush must not send the same batch at once.
  const flushLock = yield* Semaphore.make(1);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const hostPlatform = yield* HostProcess.Platform;
  const hostArchitecture = yield* HostProcess.Architecture;
  const wslDistro = Option.getOrUndefined(
    Option.flatMapNullishOr(telemetryConfig.wslDistroName, wslDistroFamily),
  );

  const releaseOwner = (pending: typeof queue, owner: OwnerReservation) => {
    const reservations = pending.owners[owner.observedBy];
    if (reservations.get(owner.key) === owner) reservations.delete(owner.key);
  };

  const enqueueBufferedEvent = (
    pending: typeof queue,
    uuid: string,
    event: string,
    properties: Readonly<Record<string, unknown>> | undefined,
    anonymous: boolean,
    owner?: OwnerReservation,
  ) =>
    Effect.flatMap(DateTime.now, (now) =>
      Effect.sync(() => {
        applyEnabled();
        if (!enabled || pending !== queue) return { size: 0, dropped: false, queued: false };
        if (
          owner &&
          (pending.owners[owner.observedBy].get(owner.key) !== owner ||
            recordedOwners[owner.observedBy].has(owner.key) ||
            recordedOwners[owner.observedBy].size >= MAX_RECORDED_OWNERS)
        ) {
          return { size: 0, dropped: false, queued: false };
        }
        const current = pending.buffer;
        const appended = [
          ...current,
          {
            uuid,
            event,
            ...(properties ? { properties } : {}),
            capturedAt: DateTime.formatIso(now),
            ...(anonymous ? { anonymous: true as const } : {}),
            ...(owner ? { owner } : {}),
          } satisfies BufferedAnalyticsEvent,
        ];

        const next =
          appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;

        pending.buffer = next;
        for (const event of appended.slice(0, appended.length - next.length)) {
          if (event.owner) releaseOwner(pending, event.owner);
        }
        if (owner) owner.queued = next.length > 0;
        return { size: next.length, dropped: next.length !== appended.length, queued: true };
      }),
    );

  const sendBatch = Effect.fn("AnalyticsService.sendBatch")(function* (
    events: ReadonlyArray<BufferedAnalyticsEvent>,
    pending: typeof queue,
  ) {
    if (!(yield* telemetryEnabled) || pending !== queue) return;
    const { distinctId, installId } = yield* identity;
    if (!distinctId || !(yield* telemetryEnabled) || pending !== queue) return;

    const payload = {
      api_key: telemetryConfig.ingestKey,
      batch: events.map((event) => ({
        uuid: event.uuid,
        event: event.event,
        distinct_id: event.anonymous ? event.uuid : distinctId,
        properties: event.anonymous
          ? {
              ...event.properties,
              $process_person_profile: false,
              t3CodeVersion: packageJson.version,
              telemetryChannel: ServerConfig.telemetryChannel,
            }
          : {
              ...event.properties,
              ...(installId === null ? {} : { installId }),
              $process_person_profile: false,
              platform: hostPlatform,
              wsl: wslDistro,
              arch: hostArchitecture,
              t3CodeVersion: packageJson.version,
              telemetryChannel: ServerConfig.telemetryChannel,
              clientType,
              serverOs: serverOsFromNodePlatform(hostPlatform),
              serverArch: hostArchitecture,
              serverWslDistro: wslDistro,
              serverAppVersion: packageJson.version,
              serverMode: serverConfig.mode,
            },
        timestamp: event.capturedAt,
      })),
    };

    yield* HttpClientRequest.post(`${telemetryConfig.ingestHost}/batch/`).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap((request) =>
        Effect.gen(function* () {
          if (!(yield* telemetryEnabled) || pending !== queue) return;
          yield* httpClient
            .execute(request)
            .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
          for (const event of events) {
            if (event.owner) {
              recordedOwners[event.owner.observedBy].add(event.owner.key);
              releaseOwner(pending, event.owner);
              const current = queue.owners[event.owner.observedBy].get(event.owner.key);
              if (current) releaseOwner(queue, current);
            }
          }
        }),
      ),
      Effect.timeout(SEND_TIMEOUT),
    );
  });

  // An anonymous event goes out alone, or the ingest could link it to the other events by request.
  const takeBatch = (pending: typeof queue) => {
    const current = pending.buffer;
    const next = current.findIndex((event) => event.anonymous);
    if (next === 0) {
      pending.buffer = current.slice(1);
      return current.slice(0, 1);
    }
    const linked = current.slice(0, next === -1 ? current.length : next);
    const batch = linked.slice(0, telemetryConfig.flushBatchSize);
    pending.buffer = current.slice(batch.length);
    return batch;
  };

  // Back off even after dropping rejected batches so bad API keys cannot drain the queue in a tight loop.
  const flush: AnalyticsService["Service"]["flush"] = Effect.gen(function* () {
    const pending = queue;
    while (true) {
      if (!(yield* telemetryEnabled) || pending !== queue) return;
      const delivery = pending.delivery;
      const buffered = delivery.failedBatch.length > 0 ? delivery.failedBatch : takeBatch(pending);
      if (buffered.length === 0) {
        return;
      }
      const ownerCounts = {
        server: recordedOwners.server.size,
        client: recordedOwners.client.size,
      };
      const batch = buffered.filter((event) => {
        const owner = event.owner;
        if (!owner) return true;
        if (
          recordedOwners[owner.observedBy].has(owner.key) ||
          ownerCounts[owner.observedBy] >= MAX_RECORDED_OWNERS
        ) {
          releaseOwner(pending, owner);
          return false;
        }
        ownerCounts[owner.observedBy]++;
        return true;
      });
      if (batch.length === 0) {
        pending.delivery = { ...delivery, failedBatch: [] };
        continue;
      }

      const sent = yield* Effect.result(sendBatch(batch, pending));
      if (pending !== queue || !(yield* telemetryEnabled)) return;
      if (Result.isSuccess(sent)) {
        pending.delivery = {
          failedBatch: [],
          batchAttempts: 0,
          firstFailedAt: 0,
          failures: 0,
          retryAt: 0,
        };
        continue;
      }

      const now = yield* Clock.currentTimeMillis;
      const failures = delivery.failures + 1;
      const batchAttempts = delivery.batchAttempts + 1;
      const firstFailedAt = delivery.batchAttempts === 0 ? now : delivery.firstFailedAt;
      const retryAt = now + retryDelayMs(failures, yield* Random.next);
      if (pending !== queue) return;
      const error = sent.failure;
      const rejected =
        error._tag === "HttpClientError" &&
        error.reason._tag === "StatusCodeError" &&
        REJECTED_BATCH_STATUSES.has(error.reason.response.status);
      if (!rejected && now - firstFailedAt < MAX_BATCH_RETRY_MS) {
        pending.delivery = {
          failedBatch: batch,
          batchAttempts,
          firstFailedAt,
          failures,
          retryAt,
        };
        yield* Effect.logDebug("Failed to send telemetry batch; will retry", {
          attempt: batchAttempts,
          cause: error,
        });
        return;
      }
      for (const event of batch) {
        if (event.owner) releaseOwner(pending, event.owner);
      }
      pending.delivery = {
        failedBatch: [],
        batchAttempts: 0,
        firstFailedAt: 0,
        failures,
        retryAt,
      };
      yield* Effect.logWarning(
        rejected
          ? "Dropped telemetry batch the endpoint rejected"
          : "Dropped telemetry batch after repeated send failures",
        { events: batch.length, attempts: batchAttempts, cause: error },
      );
      return;
    }
  }).pipe(flushLock.withPermit);

  const flushWhenDue = Effect.gen(function* () {
    const { retryAt } = queue.delivery;
    if ((yield* Clock.currentTimeMillis) >= retryAt) {
      yield* flush;
    }
  });

  const record = Effect.fn("AnalyticsService.record")(function* (
    event: string,
    properties?: Readonly<Record<string, unknown>>,
    options?: { readonly anonymous?: boolean },
    owner?: OwnerReservation,
  ) {
    const pending = queue;
    if (!(yield* telemetryEnabled) || pending !== queue) return false;
    if (owner && pending.owners[owner.observedBy].get(owner.key) !== owner) return false;
    const { distinctId } = yield* identity;
    if (!distinctId || !(yield* telemetryEnabled) || pending !== queue) return false;

    // Catch Node UUID defects too; best-effort telemetry drops events without UUIDs.
    const uuid = yield* Effect.exit(crypto.uuidV7());
    if (Exit.isFailure(uuid)) return false;

    const enqueueResult = yield* enqueueBufferedEvent(
      pending,
      uuid.value,
      event,
      properties,
      options?.anonymous === true,
      owner,
    );
    if (enqueueResult.dropped) {
      yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
        size: enqueueResult.size,
        event,
      });
    }
    return enqueueResult.queued;
  });

  const recordOwners: AnalyticsService["Service"]["recordOwners"] = Effect.fn(
    "AnalyticsService.recordOwners",
  )(function* (owners, observedBy) {
    if (!(yield* telemetryEnabled)) return;
    const pending = queue;
    for (const { source, ownerId } of owners) {
      const key = `${source}:${ownerId}`;
      const seen = recordedOwners[observedBy];
      const reservations = pending.owners[observedBy];
      if (
        seen.has(key) ||
        reservations.has(key) ||
        seen.size + reservations.size >= MAX_RECORDED_OWNERS
      )
        continue;
      const owner: OwnerReservation = { key, observedBy, queued: false };
      reservations.set(key, owner);
      yield* record(
        "install.owner_observed",
        { ownerSource: source, ownerId, observedBy },
        undefined,
        owner,
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!owner.queued) releaseOwner(pending, owner);
          }),
        ),
      );
      if (pending !== queue) return;
    }
  });

  yield* Effect.forever(Effect.sleep(FLUSH_INTERVAL_MS).pipe(Effect.andThen(flushWhenDue)), {
    disableYield: true,
  }).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() =>
    flush.pipe(Effect.timeout(SHUTDOWN_FLUSH_TIMEOUT), Effect.ignore),
  );

  return AnalyticsService.of({ record, flush, recordOwners });
});

export const layer = Layer.effect(AnalyticsService, make);
