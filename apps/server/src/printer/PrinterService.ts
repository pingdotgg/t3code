import {
  isSecretReference,
  PRINTER_MEDIA_ROUTE_PREFIX,
  type PrinterActionInput,
  type PrinterCloseInput,
  type PrinterConfig,
  type PrinterConfigureInput,
  type PrinterError,
  type PrinterId,
  type PrinterListInput,
  type PrinterOpenInput,
  PrinterOperationError,
  PrinterSafetyError,
  type PrinterServiceState,
  type PrinterSession,
  type PrinterSnapshot,
  type PrinterTestConnectionInput,
  type PrinterTestConnectionResult,
  requireSettingsSecretLiteral,
  type SettingsSecretValue,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecretResolverCore from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import {
  type PrinterAdapter,
  type PrinterMediaAsset,
  type PrinterMediaAssetKind,
  type PrinterRuntimeCache,
} from "./PrinterAdapter.ts";
import {
  pinPrinterHostAddress,
  type PrinterAddressPin,
  PrinterDnsLookup,
  PrinterPinnedAddresses,
  PrinterRequestGuard,
} from "./PrinterUrlGuard.ts";
import { homeAssistantBambuAdapter } from "./adapters/HomeAssistantBambuAdapter.ts";
import { moonrakerAdapter } from "./adapters/MoonrakerAdapter.ts";
import { octoPrintAdapter } from "./adapters/OctoPrintAdapter.ts";

export { PRINTER_MEDIA_ROUTE_PREFIX };

function adapterFor(config: PrinterConfig): PrinterAdapter {
  switch (config.kind) {
    case "home-assistant-bambu":
      return homeAssistantBambuAdapter as PrinterAdapter;
    case "moonraker":
      return moonrakerAdapter as PrinterAdapter;
    case "octoprint":
      return octoPrintAdapter as PrinterAdapter;
  }
}

function configSecretField(config: PrinterConfig): SettingsSecretValue {
  return config.kind === "home-assistant-bambu" ? config.accessToken : config.apiKey;
}

function placeholderSnapshot(config: PrinterConfig, error?: string): PrinterSnapshot {
  return {
    id: config.id,
    label: config.label,
    kind: config.kind,
    connectionState: error ? "error" : "offline",
    online: false,
    lastSyncedAt: null,
    lastUpdatedAt: null,
    stale: true,
    staleReason: error ?? "Waiting for initial telemetry from printer.",
    ...(error ? { error } : {}),
    hardware: {
      model: null,
      name: config.label,
      serial: null,
      firmware: null,
      ipAddress: null,
      nozzleSizeMm: null,
      nozzleType: null,
      bedType: null,
      totalUsageHours: null,
      wifiSignalDbm: null,
      sdCardStatus: null,
      connectionMode: null,
      controlBlocked: true,
    },
    job: {
      status: "offline",
      stage: null,
      stageLabel: null,
      fileName: null,
      displayName: null,
      progressPercent: null,
      currentLayer: null,
      totalLayers: null,
      remainingSeconds: null,
      elapsedSeconds: null,
      startedAt: null,
      estimatedFinishAt: null,
      weightGrams: null,
      lengthMeters: null,
      timelapse: null,
      printableObjects: [],
    },
    thermals: {
      nozzle: { actualC: null, targetC: null },
      bed: { actualC: null, targetC: null },
      history: [],
    },
    fans: {
      coolingPercent: null,
      auxPercent: null,
      chamberPercent: null,
      heatbreakPercent: null,
    },
    lighting: { chamberLight: null },
    speed: { profile: null, modifierPercent: null },
    filament: { extruderLoaded: null, externalSpool: null, amsUnits: [] },
    alerts: [],
    media: {
      hasCamera: false,
      hasCoverImage: false,
      hasPickImage: false,
      cameraUpdatedAt: null,
      cameraStale: true,
      cameraRevision: 0,
      coverUpdatedAt: null,
    },
    capabilities: {
      canPause: false,
      canResume: false,
      canStop: false,
      canSetTemps: false,
      canSetFans: false,
      canSetLight: false,
      canSetSpeed: false,
      canJog: false,
      canSkipObjects: false,
    },
  };
}

function originOfUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

function normalizedUrlTarget(raw: string | undefined, preserveTrailingSlash = false): string {
  if (!raw?.trim()) return "";
  try {
    const parsed = new URL(raw.trim());
    const pathname = preserveTrailingSlash ? parsed.pathname : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${pathname}${parsed.search}`;
  } catch {
    return raw.trim();
  }
}

function configTargetSignature(config: PrinterConfig): string {
  const base = normalizedUrlTarget(config.baseUrl, false);
  if (config.kind === "home-assistant-bambu") {
    const prefix = config.entityPrefix?.trim().replace(/\.$/, "").toLowerCase() ?? "";
    return `${config.kind}|${base}|${prefix}|${config.deviceId?.trim() ?? ""}`;
  }
  return `${config.kind}|${base}|${normalizedUrlTarget(config.webcamUrl, true)}`;
}

function validateSafetyGuards(
  snapshot: PrinterSnapshot,
  input: PrinterActionInput,
): Effect.Effect<void, PrinterSafetyError> {
  const { action, printerId } = input;
  const isSafeMotionState = snapshot.job.status === "idle" || snapshot.job.status === "finish";

  if (action.kind === "refresh") return Effect.void;

  if (!snapshot.online) {
    return Effect.fail(
      new PrinterSafetyError({
        action: action.kind,
        printerId,
        reason: "Printer is offline. Wait until it reconnects before sending commands.",
      }),
    );
  }

  if (snapshot.hardware.controlBlocked) {
    return Effect.fail(
      new PrinterSafetyError({
        action: action.kind,
        printerId,
        reason:
          snapshot.hardware.controlBlockedReason ??
          "Printer write control is currently blocked by printer firmware.",
      }),
    );
  }

  if (action.kind === "homeAxes" || action.kind === "moveAxis") {
    if (!isSafeMotionState || snapshot.stale) {
      return Effect.fail(
        new PrinterSafetyError({
          action: action.kind,
          printerId,
          reason:
            "Axis homing and jogging are only allowed when fresh telemetry confirms the printer is idle or finished.",
        }),
      );
    }
    if (action.kind === "moveAxis" && action.distanceMm === 0) {
      return Effect.fail(
        new PrinterSafetyError({
          action: action.kind,
          printerId,
          reason: "Move distance must be non-zero.",
        }),
      );
    }
  }

  if (
    action.kind === "pause" ||
    action.kind === "resume" ||
    action.kind === "stop" ||
    action.kind === "skipObjects"
  ) {
    if (
      action.expectedJobFileName !== undefined &&
      action.expectedJobFileName !== null &&
      (snapshot.job.fileName === null || action.expectedJobFileName !== snapshot.job.fileName)
    ) {
      return Effect.fail(
        new PrinterSafetyError({
          action: action.kind,
          printerId,
          reason:
            snapshot.job.fileName === null
              ? `Active print job filename is unavailable; cannot confirm "${action.expectedJobFileName}" before ${action.kind}.`
              : `Active print job changed to "${snapshot.job.fileName}". Refresh before retrying ${action.kind}.`,
        }),
      );
    }
    if (
      action.expectedJobStartedAt !== undefined &&
      action.expectedJobStartedAt !== null &&
      (snapshot.job.startedAt === null || action.expectedJobStartedAt !== snapshot.job.startedAt)
    ) {
      return Effect.fail(
        new PrinterSafetyError({
          action: action.kind,
          printerId,
          reason:
            snapshot.job.startedAt === null
              ? `Active print job start timestamp is unavailable; cannot confirm the target job before ${action.kind}.`
              : `Active print job restarted or changed since confirmation. Refresh before retrying ${action.kind}.`,
        }),
      );
    }
  }

  if (action.kind === "skipObjects") {
    if (snapshot.job.status !== "running" && snapshot.job.status !== "pause") {
      return Effect.fail(
        new PrinterSafetyError({
          action: action.kind,
          printerId,
          reason: "Objects can only be skipped during an active or paused print.",
        }),
      );
    }
    if (snapshot.job.printableObjects.length === 0) {
      return Effect.fail(
        new PrinterSafetyError({
          action: action.kind,
          printerId,
          reason:
            "Printable object metadata is unavailable from fresh telemetry; cannot verify object selection.",
        }),
      );
    }
    const byId = new Map(snapshot.job.printableObjects.map((obj) => [obj.id, obj]));
    for (const objectId of action.objectIds) {
      const matched = byId.get(objectId);
      if (!matched) {
        return Effect.fail(
          new PrinterSafetyError({
            action: action.kind,
            printerId,
            reason: `Object ${objectId} does not belong to the active print job. Refresh before retrying.`,
          }),
        );
      }
      if (matched.skipped) {
        return Effect.fail(
          new PrinterSafetyError({
            action: action.kind,
            printerId,
            reason: `Object "${matched.name}" is already skipped in this print job.`,
          }),
        );
      }
    }
  }

  return Effect.void;
}

export class PrinterService extends Context.Service<
  PrinterService,
  {
    readonly state: Effect.Effect<PrinterServiceState>;
    readonly subscribe: Effect.Effect<PubSub.Subscription<PrinterServiceState>, never, Scope.Scope>;
    readonly configure: (
      input: PrinterConfigureInput,
    ) => Effect.Effect<PrinterServiceState, PrinterError>;
    readonly testConnection: (
      input: PrinterTestConnectionInput,
    ) => Effect.Effect<PrinterTestConnectionResult, PrinterError>;
    readonly list: (input?: PrinterListInput) => Effect.Effect<PrinterServiceState, PrinterError>;
    readonly open: (input: PrinterOpenInput) => Effect.Effect<PrinterSession, PrinterError>;
    readonly close: (input: PrinterCloseInput) => Effect.Effect<void, PrinterError>;
    readonly action: (input: PrinterActionInput) => Effect.Effect<PrinterSnapshot, PrinterError>;
    readonly fetchMedia: (
      printerId: PrinterId,
      kind: PrinterMediaAssetKind,
    ) => Effect.Effect<PrinterMediaAsset, PrinterOperationError>;
    readonly sessionsForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<PrinterSession>>;
  }
>()("t3/printer/PrinterService") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secretResolver = yield* SecretResolverCore.SecretResolver;
  const httpClient = yield* HttpClient.HttpClient;
  const dnsLookupOption = yield* Effect.serviceOption(PrinterDnsLookup);
  const serviceScope = yield* Effect.scope;
  const pubsub = yield* PubSub.unbounded<PrinterServiceState>();

  const withHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) => {
    const provided = Effect.provideService(effect, HttpClient.HttpClient, httpClient);
    return Option.isSome(dnsLookupOption)
      ? Effect.provideService(provided, PrinterDnsLookup, dnsLookupOption.value)
      : provided;
  };

  const initialSettings = yield* settingsService.getSettings.pipe(
    Effect.orElseSucceed(() => ({
      enablePrinterSupport: false,
      enableAgentPrinterAccess: false,
      printers: [] as ReadonlyArray<PrinterConfig>,
      secretProviders: {},
    })),
  );

  const stateRef = yield* Ref.make<PrinterServiceState>({
    enabled: initialSettings.enablePrinterSupport,
    agentAccessEnabled: initialSettings.enableAgentPrinterAccess,
    mediaBasePath: PRINTER_MEDIA_ROUTE_PREFIX,
    printers: initialSettings.printers.map((config) => placeholderSnapshot(config)),
    sessions: [],
    revision: 0,
  });

  const caches = new Map<string, PrinterRuntimeCache>();
  const configsById = new Map<string, PrinterConfig>(
    initialSettings.printers.map((config) => [config.id, config]),
  );
  const generationsById = new Map<string, number>(
    initialSettings.printers.map((config) => [config.id, 1]),
  );
  const pollSeqById = new Map<string, number>();
  const committedPollSeqById = new Map<string, number>();
  const mediaSeqById = new Map<string, number>();
  const committedMediaSeqById = new Map<string, number>();
  const actionLocksById = new Map<string, Semaphore.Semaphore>();
  let supportEnabled = initialSettings.enablePrinterSupport;

  const actionLockFor = (id: string): Semaphore.Semaphore => {
    let lock = actionLocksById.get(id);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      actionLocksById.set(id, lock);
    }
    return lock;
  };
  const bumpGeneration = (id: string): number => {
    const next = (generationsById.get(id) ?? 0) + 1;
    generationsById.set(id, next);
    committedPollSeqById.set(id, pollSeqById.get(id) ?? 0);
    for (const kind of ["camera", "cover", "pick"] as const) {
      const mediaKey = `${id}:${kind}`;
      committedMediaSeqById.set(mediaKey, mediaSeqById.get(mediaKey) ?? 0);
    }
    return next;
  };
  const makeTargetGuard = (config: PrinterConfig, generation: number, operation: string) => () =>
    supportEnabled &&
    configsById.get(config.id) === config &&
    generationsById.get(config.id) === generation
      ? Effect.void
      : Effect.fail(
          new PrinterOperationError({
            operation,
            printerId: config.id,
            reason: !supportEnabled
              ? "3D Printer support was disabled before sending request."
              : "Printer configuration changed before sending request. Retry after refreshing.",
          }),
        );

  const mergePollCache = (id: string, pollCache: PrinterRuntimeCache): PrinterRuntimeCache => {
    const current = caches.get(id) ?? {};
    const merged: PrinterRuntimeCache = {
      ...pollCache,
      // Media freshness fields are owned exclusively by fetchMedia so slow polls never regress camera change tracking.
      ...(current.lastCameraHash !== undefined ? { lastCameraHash: current.lastCameraHash } : {}),
      ...(current.lastCameraChangedAtMs !== undefined
        ? { lastCameraChangedAtMs: current.lastCameraChangedAtMs }
        : {}),
    };
    caches.set(id, merged);
    return merged;
  };

  const mergeMediaCache = (id: string, mediaCache: PrinterRuntimeCache): PrinterRuntimeCache => {
    const current = caches.get(id) ?? {};
    const merged: PrinterRuntimeCache = {
      ...current,
      ...(mediaCache.lastCameraHash !== undefined
        ? { lastCameraHash: mediaCache.lastCameraHash }
        : {}),
      ...(mediaCache.lastCameraChangedAtMs !== undefined
        ? { lastCameraChangedAtMs: mediaCache.lastCameraChangedAtMs }
        : {}),
    };
    caches.set(id, merged);
    return merged;
  };

  /* Internal state mutation helper covered by each caller's span. */
  const publish = Effect.fnUntraced(function* (
    updater: (current: PrinterServiceState) => PrinterServiceState,
  ) {
    const next = yield* Ref.updateAndGet(stateRef, (current) => {
      const updated = updater(current);
      return { ...updated, revision: current.revision + 1 };
    });
    yield* PubSub.publish(pubsub, next);
    return next;
  });

  const resolvePrinterSecret = Effect.fn("PrinterService.resolvePrinterSecret")(function* (
    config: PrinterConfig,
    existingPrinterId?: PrinterId,
  ) {
    const currentSettings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () =>
          new PrinterOperationError({
            operation: "resolveSecret",
            printerId: config.id,
            reason: "Failed to read server settings.",
          }),
      ),
    );
    let raw = configSecretField(config);
    const saved = currentSettings.printers.find(
      (entry) => entry.id === (existingPrinterId ?? config.id),
    );
    const savedRaw = saved ? configSecretField(saved) : undefined;
    const isReusedSavedReference =
      savedRaw !== undefined &&
      isSecretReference(raw) &&
      isSecretReference(savedRaw) &&
      raw.provider === savedRaw.provider &&
      raw.reference === savedRaw.reference;

    if (saved && (raw === SECRET_REDACTED || isReusedSavedReference)) {
      const savedOrigin = originOfUrl(saved.baseUrl);
      const nextOrigin = originOfUrl(config.baseUrl);
      const savedWebcamOrigin =
        saved.kind !== "home-assistant-bambu" ? originOfUrl(saved.webcamUrl) : null;
      const nextWebcamOrigin =
        config.kind !== "home-assistant-bambu" ? originOfUrl(config.webcamUrl) : null;
      if (
        saved.kind !== config.kind ||
        savedOrigin === null ||
        savedOrigin !== nextOrigin ||
        savedWebcamOrigin !== nextWebcamOrigin
      ) {
        return yield* new PrinterOperationError({
          operation: "resolveSecret",
          printerId: config.id,
          reason:
            "Re-enter the printer credential after changing the printer backend or destination host.",
        });
      }
      if (raw === SECRET_REDACTED) {
        raw = savedRaw!;
      }
    }
    if (isSecretReference(raw)) {
      const [resolved] = yield* secretResolver.read([raw]);
      if (resolved === undefined) {
        const providerLabel = yield* secretResolver.label(raw.provider);
        return yield* new PrinterOperationError({
          operation: "resolveSecret",
          printerId: config.id,
          reason: `Could not resolve printer credential from secret provider "${providerLabel}".`,
        });
      }
      return resolved;
    }
    return yield* requireSettingsSecretLiteral(raw, currentSettings.secretProviders).pipe(
      Effect.mapError(
        (error) =>
          new PrinterOperationError({
            operation: "resolveSecret",
            printerId: config.id,
            reason: error.message,
          }),
      ),
    );
  });

  const pollOne = Effect.fn("PrinterService.pollOne")(function* (
    config: PrinterConfig,
    expectedGeneration?: number,
    pinnedAddresses?: ReadonlyMap<string, PrinterAddressPin>,
  ) {
    const generation = expectedGeneration ?? generationsById.get(config.id) ?? 0;
    const pollSeq = (pollSeqById.get(config.id) ?? 0) + 1;
    pollSeqById.set(config.id, pollSeq);
    const currentState = yield* Ref.get(stateRef);
    const previous = currentState.printers.find((printer) => printer.id === config.id);
    const cache = caches.get(config.id) ?? {};
    if (
      !supportEnabled ||
      configsById.get(config.id) !== config ||
      generationsById.get(config.id) !== generation
    ) {
      return {
        snapshot: previous ?? placeholderSnapshot(config),
        cache,
        generation,
        committed: false,
      };
    }
    const makeErrorResult = (message: string) => ({
      snapshot: previous
        ? {
            ...previous,
            connectionState: "error" as const,
            online: false,
            stale: true,
            staleReason: message,
            error: message,
            capabilities: {
              canPause: false,
              canResume: false,
              canStop: false,
              canSetTemps: false,
              canSetFans: false,
              canSetLight: false,
              canSetSpeed: false,
              canJog: false,
              canSkipObjects: false,
            },
          }
        : placeholderSnapshot(config, message),
      cache,
    });
    const secretResult = yield* Effect.result(resolvePrinterSecret(config));
    if (
      !supportEnabled ||
      configsById.get(config.id) !== config ||
      generationsById.get(config.id) !== generation ||
      pollSeq <= (committedPollSeqById.get(config.id) ?? 0)
    ) {
      return {
        snapshot: previous ?? placeholderSnapshot(config),
        cache,
        generation,
        committed: false,
      };
    }
    const runPoll = adapterFor(config)
      .poll(config, secretResult._tag === "Success" ? secretResult.success : "", previous, cache)
      .pipe(
        Effect.provideService(PrinterRequestGuard, makeTargetGuard(config, generation, "poll")),
      );
    const result =
      secretResult._tag === "Failure"
        ? makeErrorResult(secretResult.failure.message)
        : yield* withHttp(
            pinnedAddresses && pinnedAddresses.size > 0
              ? Effect.provideService(runPoll, PrinterPinnedAddresses, pinnedAddresses)
              : runPoll,
          ).pipe(Effect.catch((error) => Effect.succeed(makeErrorResult(error.message))));

    if (
      !supportEnabled ||
      configsById.get(config.id) !== config ||
      generationsById.get(config.id) !== generation ||
      pollSeq <= (committedPollSeqById.get(config.id) ?? 0)
    ) {
      return { snapshot: result.snapshot, cache: result.cache, generation, committed: false };
    }
    committedPollSeqById.set(config.id, pollSeq);
    const mergedCache = mergePollCache(config.id, result.cache);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const publishedSnapshot: PrinterSnapshot =
      mergedCache.lastCameraChangedAtMs !== undefined
        ? (() => {
            const mediaUpdatedIso = DateTime.formatIso(
              DateTime.makeUnsafe(mergedCache.lastCameraChangedAtMs),
            );
            const existingUpdatedMs = result.snapshot.media.cameraUpdatedAt
              ? Date.parse(result.snapshot.media.cameraUpdatedAt)
              : Number.NaN;
            const cameraUpdatedAt =
              !Number.isFinite(existingUpdatedMs) ||
              mergedCache.lastCameraChangedAtMs > existingUpdatedMs
                ? mediaUpdatedIso
                : result.snapshot.media.cameraUpdatedAt;
            const cameraHealthy = mergedCache.cameraEntityHealthy ?? result.snapshot.online;
            const cameraStale =
              !result.snapshot.online ||
              !cameraHealthy ||
              (result.snapshot.job.status === "running" &&
                nowMs - mergedCache.lastCameraChangedAtMs > 30_000);
            return {
              ...result.snapshot,
              media: {
                ...result.snapshot.media,
                cameraUpdatedAt,
                cameraStale,
              },
            };
          })()
        : result.snapshot;
    yield* publish((current) => {
      const exists = current.printers.some((entry) => entry.id === config.id);
      return {
        ...current,
        printers: exists
          ? current.printers.map((entry) => (entry.id === config.id ? publishedSnapshot : entry))
          : [...current.printers, publishedSnapshot],
      };
    });
    return { snapshot: publishedSnapshot, cache: mergedCache, generation, committed: true };
  });

  const applySettingsState = Effect.fn("PrinterService.applySettingsState")(
    function* (nextSettings: {
      readonly enablePrinterSupport: boolean;
      readonly enableAgentPrinterAccess: boolean;
      readonly printers: ReadonlyArray<PrinterConfig>;
    }) {
      supportEnabled = nextSettings.enablePrinterSupport;
      const nextIds = new Set(nextSettings.printers.map((printer) => printer.id));
      for (const id of configsById.keys()) {
        if (!nextIds.has(id as PrinterId)) {
          configsById.delete(id);
          caches.delete(id);
          actionLocksById.delete(id);
          bumpGeneration(id);
        }
      }
      const retargetedIds = new Set<string>();
      for (const config of nextSettings.printers) {
        const previousConfig = configsById.get(config.id);
        if (
          !previousConfig ||
          configTargetSignature(previousConfig) !== configTargetSignature(config)
        ) {
          caches.delete(config.id);
          bumpGeneration(config.id);
          if (previousConfig) {
            retargetedIds.add(config.id);
          }
        }
        configsById.set(config.id, config);
      }
      yield* publish((current) => {
        const existingById = new Map(current.printers.map((entry) => [entry.id, entry]));
        return {
          ...current,
          enabled: nextSettings.enablePrinterSupport,
          agentAccessEnabled: nextSettings.enableAgentPrinterAccess,
          printers: nextSettings.printers.map((config) => {
            const existing = existingById.get(config.id);
            return existing && existing.kind === config.kind && !retargetedIds.has(config.id)
              ? { ...existing, label: config.label }
              : placeholderSnapshot(config);
          }),
          sessions: current.sessions.filter(
            (session) => session.proxyEnvironmentId !== undefined || nextIds.has(session.printerId),
          ),
        };
      });
      return nextSettings.enablePrinterSupport
        ? nextSettings.printers.map((config) => ({
            config,
            generation: generationsById.get(config.id) ?? 0,
          }))
        : [];
    },
  );

  const syncLatestSettings = Effect.fn("PrinterService.syncLatestSettings")(function* (fallback: {
    readonly enablePrinterSupport: boolean;
    readonly enableAgentPrinterAccess: boolean;
    readonly printers: ReadonlyArray<PrinterConfig>;
  }) {
    // Always read the authoritative current settings so queued subscriber events never reinstall an older revision.
    const latest = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => fallback));
    return yield* applySettingsState(latest);
  });

  const settingsStream = yield* settingsService.subscribeChanges;
  yield* Stream.runForEach(settingsStream, (updated) =>
    Effect.gen(function* () {
      const targets = yield* syncLatestSettings(updated);
      if (targets.length > 0) {
        yield* Effect.forEach(targets, ({ config, generation }) => pollOne(config, generation), {
          concurrency: 4,
        }).pipe(Effect.ignore, Effect.forkIn(serviceScope));
      }
    }),
  ).pipe(Effect.forkIn(serviceScope));

  const pollLoop = Effect.gen(function* () {
    const current = yield* Ref.get(stateRef);
    if (!current.enabled || configsById.size === 0) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const hasOpenSessions = current.sessions.length > 0;
    const due: Array<{ readonly config: PrinterConfig; readonly generation: number }> = [];
    for (const config of configsById.values()) {
      const snap = current.printers.find((entry) => entry.id === config.id);
      const activePrint =
        snap?.job.status === "running" ||
        snap?.job.status === "prepare" ||
        snap?.job.status === "pause";
      const intervalMs =
        activePrint || hasOpenSessions
          ? Math.max(2_000, (config.pollIntervalSeconds ?? 4) * 1000)
          : Math.max(12_000, (config.pollIntervalSeconds ?? 4) * 3000);
      const lastMs = snap?.lastSyncedAt ? Date.parse(snap.lastSyncedAt) : 0;
      if (!lastMs || nowMs - lastMs >= intervalMs) {
        due.push({ config, generation: generationsById.get(config.id) ?? 0 });
      }
    }
    if (due.length > 0) {
      yield* Effect.forEach(due, ({ config, generation }) => pollOne(config, generation), {
        concurrency: 4,
      }).pipe(Effect.ignore);
    }
  });

  const pollFiber = yield* Effect.repeat(pollLoop, Schedule.spaced(Duration.seconds(2))).pipe(
    Effect.forkIn(serviceScope),
  );
  yield* Effect.addFinalizer(() => Fiber.interrupt(pollFiber));

  if (initialSettings.enablePrinterSupport && initialSettings.printers.length > 0) {
    const initialTargets = initialSettings.printers.map((config) => ({
      config,
      generation: generationsById.get(config.id) ?? 0,
    }));
    yield* Effect.forEach(initialTargets, ({ config, generation }) => pollOne(config, generation), {
      concurrency: 4,
    }).pipe(Effect.ignore, Effect.forkIn(serviceScope));
  }

  const configure: PrinterService["Service"]["configure"] = Effect.fn("PrinterService.configure")(
    function* (input) {
      const updated = yield* settingsService
        .updateSettings({
          ...(input.enabled === undefined ? {} : { enablePrinterSupport: input.enabled }),
          ...(input.agentAccessEnabled === undefined
            ? {}
            : { enableAgentPrinterAccess: input.agentAccessEnabled }),
          ...(input.printers === undefined ? {} : { printers: input.printers }),
        })
        .pipe(
          Effect.mapError(
            () =>
              new PrinterOperationError({
                operation: "configure",
                reason: "Failed to save 3D printer settings.",
              }),
          ),
        );
      const targets = yield* syncLatestSettings(updated);
      if (targets.length > 0) {
        yield* Effect.forEach(targets, ({ config, generation }) => pollOne(config, generation), {
          concurrency: 4,
        }).pipe(Effect.ignore);
      }
      return yield* Ref.get(stateRef);
    },
  );

  const testConnection: PrinterService["Service"]["testConnection"] = Effect.fn(
    "PrinterService.testConnection",
  )(function* (input) {
    const secret = yield* resolvePrinterSecret(input.config, input.existingPrinterId);
    return yield* withHttp(adapterFor(input.config).testConnection(input.config, secret));
  });

  const list: PrinterService["Service"]["list"] = Effect.fn("PrinterService.list")(
    function* (input) {
      const current = yield* Ref.get(stateRef);
      if (!current.enabled) return current;
      if (input?.refresh !== false) {
        const targets = (
          input?.printerId
            ? [...configsById.values()].filter((config) => config.id === input.printerId)
            : [...configsById.values()]
        ).map((config) => ({ config, generation: generationsById.get(config.id) ?? 0 }));
        if (targets.length > 0) {
          yield* Effect.forEach(targets, ({ config, generation }) => pollOne(config, generation), {
            concurrency: 4,
          }).pipe(Effect.ignore);
        }
      }
      return yield* Ref.get(stateRef);
    },
  );

  const open: PrinterService["Service"]["open"] = Effect.fn("PrinterService.open")(
    function* (input) {
      const currentState = yield* Ref.get(stateRef);
      if (!input.proxyEnvironmentId && !currentState.enabled) {
        return yield* new PrinterOperationError({
          operation: "open",
          printerId: input.printerId,
          reason: "3D Printer support is disabled in Settings.",
        });
      }
      const config = input.proxyEnvironmentId ? undefined : configsById.get(input.printerId);
      if (!input.proxyEnvironmentId && !config) {
        return yield* new PrinterOperationError({
          operation: "open",
          printerId: input.printerId,
          reason: `Printer "${input.printerId}" is not configured.`,
        });
      }
      const existing = currentState.sessions.find(
        (session) =>
          session.threadId === input.threadId &&
          session.printerId === input.printerId &&
          session.proxyEnvironmentId === input.proxyEnvironmentId,
      );
      const openedAt = DateTime.formatIso(yield* DateTime.now);
      const session: PrinterSession = existing ?? {
        threadId: input.threadId,
        printerId: input.printerId,
        ...(input.proxyEnvironmentId ? { proxyEnvironmentId: input.proxyEnvironmentId } : {}),
        ...(input.printerLabel ? { printerLabel: input.printerLabel } : {}),
        openedAt,
      };
      if (!existing) {
        yield* publish((current) => ({
          ...current,
          sessions: [...current.sessions, session],
        }));
      }
      if (config && supportEnabled) {
        const generation = generationsById.get(config.id) ?? 0;
        yield* pollOne(config, generation).pipe(Effect.ignore);
      }
      return session;
    },
  );

  const close: PrinterService["Service"]["close"] = Effect.fn("PrinterService.close")(
    function* (input) {
      yield* publish((current) => ({
        ...current,
        sessions: current.sessions.filter((session) => {
          if (session.threadId !== input.threadId) return true;
          if (input.printerId !== undefined && session.printerId !== input.printerId) return true;
          if (input.proxyEnvironmentId === null && session.proxyEnvironmentId !== undefined) {
            return true;
          }
          if (
            input.proxyEnvironmentId !== undefined &&
            input.proxyEnvironmentId !== null &&
            session.proxyEnvironmentId !== input.proxyEnvironmentId
          ) {
            return true;
          }
          return false;
        }),
      }));
    },
  );

  const action: PrinterService["Service"]["action"] = Effect.fn("PrinterService.action")(
    function* (input) {
      // Capture target identity and generation BEFORE waiting on the per-printer lock so a queued command
      // can never execute against a retargeted replacement printer that reuses the same printerId.
      const initialState = yield* Ref.get(stateRef);
      if (!initialState.enabled || !supportEnabled) {
        return yield* new PrinterOperationError({
          operation: input.action.kind,
          printerId: input.printerId,
          reason: "3D Printer support is disabled in Settings.",
        });
      }
      const capturedConfig = configsById.get(input.printerId);
      if (!capturedConfig) {
        return yield* new PrinterOperationError({
          operation: input.action.kind,
          printerId: input.printerId,
          reason: `Printer "${input.printerId}" is not configured.`,
        });
      }
      const capturedGeneration = generationsById.get(capturedConfig.id) ?? 0;

      return yield* actionLockFor(input.printerId).withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(stateRef);
          if (!current.enabled || !supportEnabled) {
            return yield* new PrinterOperationError({
              operation: input.action.kind,
              printerId: input.printerId,
              reason: "3D Printer support is disabled in Settings.",
            });
          }
          const config = configsById.get(input.printerId);
          const generation = generationsById.get(input.printerId) ?? 0;
          if (!config || config !== capturedConfig || generation !== capturedGeneration) {
            return yield* new PrinterOperationError({
              operation: input.action.kind,
              printerId: input.printerId,
              reason:
                "Printer configuration changed while command was queued. Retry after refreshing.",
            });
          }
          const pinnedAddresses = yield* Option.isSome(dnsLookupOption)
            ? Effect.provideService(
                pinPrinterHostAddress(config.baseUrl, input.action.kind, config.id),
                PrinterDnsLookup,
                dnsLookupOption.value,
              )
            : pinPrinterHostAddress(config.baseUrl, input.action.kind, config.id);
          const fresh = yield* pollOne(config, generation, pinnedAddresses);
          if (
            !fresh.committed ||
            !supportEnabled ||
            configsById.get(config.id) !== config ||
            generationsById.get(config.id) !== generation
          ) {
            return yield* new PrinterSafetyError({
              action: input.action.kind,
              printerId: input.printerId,
              reason:
                "Printer state or configuration changed while verifying readiness. Retry after refreshing.",
            });
          }
          yield* validateSafetyGuards(fresh.snapshot, input);
          const secret = yield* resolvePrinterSecret(config);
          let guardSafetyError: PrinterSafetyError | undefined;
          const baseGuard = makeTargetGuard(config, generation, input.action.kind);
          const requestGuard = Effect.fn("PrinterService.actionRequestGuard")(function* () {
            yield* baseGuard();
            const latestSnapshot = (yield* Ref.get(stateRef)).printers.find(
              (entry) => entry.id === config.id,
            );
            if (!latestSnapshot) {
              guardSafetyError = new PrinterSafetyError({
                action: input.action.kind,
                printerId: input.printerId,
                reason:
                  "Printer telemetry disappeared before dispatching action. Retry after refreshing.",
              });
              return yield* new PrinterOperationError({
                operation: input.action.kind,
                printerId: input.printerId,
                reason: guardSafetyError.reason,
              });
            }
            const safetyCheck = yield* Effect.result(validateSafetyGuards(latestSnapshot, input));
            if (safetyCheck._tag === "Failure") {
              guardSafetyError = safetyCheck.failure;
              return yield* new PrinterOperationError({
                operation: input.action.kind,
                printerId: input.printerId,
                reason: safetyCheck.failure.reason,
              });
            }
          });
          if (
            !supportEnabled ||
            configsById.get(config.id) !== config ||
            generationsById.get(config.id) !== generation
          ) {
            return yield* new PrinterSafetyError({
              action: input.action.kind,
              printerId: input.printerId,
              reason:
                "Printer configuration changed before dispatching action. Retry after refreshing.",
            });
          }
          const runAction = adapterFor(config)
            .executeAction(config, secret, input.action, fresh.snapshot, fresh.cache)
            .pipe(Effect.provideService(PrinterRequestGuard, requestGuard));
          yield* withHttp(
            pinnedAddresses.size > 0
              ? Effect.provideService(runAction, PrinterPinnedAddresses, pinnedAddresses)
              : runAction,
          ).pipe(
            Effect.catch((error) =>
              guardSafetyError ? Effect.fail(guardSafetyError) : Effect.fail(error),
            ),
          );
          if (
            !supportEnabled ||
            configsById.get(config.id) !== config ||
            generationsById.get(config.id) !== generation
          ) {
            return fresh.snapshot;
          }
          return (yield* pollOne(config, generation, pinnedAddresses)).snapshot;
        }),
      );
    },
  );

  const fetchMedia: PrinterService["Service"]["fetchMedia"] = Effect.fn(
    "PrinterService.fetchMedia",
  )(function* (printerId, kind) {
    const current = yield* Ref.get(stateRef);
    if (!current.enabled) {
      return yield* new PrinterOperationError({
        operation: `media.${kind}`,
        printerId,
        reason: "3D Printer support is disabled.",
      });
    }
    const config = configsById.get(printerId);
    if (!config) {
      return yield* new PrinterOperationError({
        operation: `media.${kind}`,
        printerId,
        reason: `Printer "${printerId}" is not configured.`,
      });
    }
    const generation = generationsById.get(printerId) ?? 0;
    const mediaKey = `${printerId}:${kind}`;
    const mediaSeq = (mediaSeqById.get(mediaKey) ?? 0) + 1;
    mediaSeqById.set(mediaKey, mediaSeq);
    const snapshot = current.printers.find((entry) => entry.id === printerId);
    const cache = caches.get(printerId) ?? {};
    const secret = yield* resolvePrinterSecret(config);
    if (
      !supportEnabled ||
      configsById.get(printerId) !== config ||
      generationsById.get(printerId) !== generation
    ) {
      return yield* new PrinterOperationError({
        operation: `media.${kind}`,
        printerId,
        reason: "Printer configuration changed before fetching media.",
      });
    }
    const { asset, cache: nextCache } = yield* withHttp(
      adapterFor(config)
        .fetchMedia(config, secret, kind, snapshot, cache)
        .pipe(
          Effect.provideService(
            PrinterRequestGuard,
            makeTargetGuard(config, generation, `media.${kind}`),
          ),
        ),
    );
    if (
      !supportEnabled ||
      configsById.get(printerId) !== config ||
      generationsById.get(printerId) !== generation
    ) {
      return yield* new PrinterOperationError({
        operation: `media.${kind}`,
        printerId,
        reason: "Printer configuration changed while fetching media.",
      });
    }
    if (kind === "camera" && mediaSeq > (committedMediaSeqById.get(mediaKey) ?? 0)) {
      committedMediaSeqById.set(mediaKey, mediaSeq);
      const prevChangedAtMs = caches.get(printerId)?.lastCameraChangedAtMs;
      const mergedCache = mergeMediaCache(printerId, nextCache);
      const frameChanged =
        mergedCache.lastCameraChangedAtMs !== undefined &&
        mergedCache.lastCameraChangedAtMs !== prevChangedAtMs;
      const updatedIso =
        mergedCache.lastCameraChangedAtMs !== undefined
          ? DateTime.formatIso(DateTime.makeUnsafe(mergedCache.lastCameraChangedAtMs))
          : asset.capturedAt;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const latestState = yield* Ref.get(stateRef);
      const latestEntry = latestState.printers.find((entry) => entry.id === printerId);
      if (latestEntry) {
        const cameraHealthy = mergedCache.cameraEntityHealthy ?? latestEntry.online;
        const computedStale =
          !latestEntry.online ||
          !cameraHealthy ||
          (latestEntry.job.status === "running" &&
            mergedCache.lastCameraChangedAtMs !== undefined &&
            nowMs - mergedCache.lastCameraChangedAtMs > 30_000);
        if (latestEntry.media.cameraStale !== computedStale || frameChanged) {
          yield* publish((state) => ({
            ...state,
            printers: state.printers.map((entry) =>
              entry.id === printerId
                ? {
                    ...entry,
                    media: {
                      ...entry.media,
                      cameraStale: computedStale,
                      cameraUpdatedAt: updatedIso,
                    },
                  }
                : entry,
            ),
          }));
        }
      }
    }
    return asset;
  });

  const sessionsForThread: PrinterService["Service"]["sessionsForThread"] = (threadId) =>
    Ref.get(stateRef).pipe(
      Effect.map((current) => current.sessions.filter((session) => session.threadId === threadId)),
    );

  return PrinterService.of({
    state: Ref.get(stateRef),
    subscribe: PubSub.subscribe(pubsub),
    configure,
    testConnection,
    list,
    open,
    close,
    action,
    fetchMedia,
    sessionsForThread,
  });
});

export const layer = Layer.effect(PrinterService, make);

export const stateStream = (
  service: PrinterService["Service"],
): Stream.Stream<PrinterServiceState> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* service.subscribe;
      const initial = yield* service.state;
      return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
    }),
  ).pipe(Stream.scoped);
