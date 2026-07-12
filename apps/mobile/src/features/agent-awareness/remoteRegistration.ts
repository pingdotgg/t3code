import { type LiveActivity } from "expo-widgets";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AppState, Platform } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  type RelayDeviceRegistrationRequest,
  type RelayAgentActivitySnapshotResponse,
  type RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import type { SavedRemoteConnection } from "../../lib/connection";
import { runtime } from "../../lib/runtime";
import type { Preferences } from "../../persistence/mobile-preferences";
import {
  clearAgentAwarenessRegistrationRecord,
  loadAgentAwarenessDeviceId,
  loadAgentAwarenessRegistrationRecord,
  loadOrCreateAgentAwarenessDeviceId,
  loadPreferences,
  saveAgentAwarenessRegistrationRecord,
} from "../../persistence/imperative";
import AgentActivity, { type AgentActivityProps } from "../../widgets/AgentActivity";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { supportsAgentAwarenessPush } from "./capabilities";
import { makeRelayDeviceRegistrationRequest, resolveApsEnvironment } from "./registrationPayload";

const REMOTE_ACTIVITY_REGISTRATION_RETRY_MS = 15_000;

const AgentAwarenessOperation = Schema.Literals([
  "read-notification-permissions",
  "read-native-push-token",
  "read-device-registration-relay-token",
  "read-device-unregistration-relay-token",
  "read-live-activity-registration-relay-token",
  "load-device-registration-identifier",
  "load-device-registration-preferences",
  "load-device-unregistration-identifier",
  "read-live-activity-push-token",
  "load-live-activity-registration-identifier",
  "list-active-live-activities",
  "load-live-activity-prime-preferences",
  "prime-live-activity",
]);

export class AgentAwarenessOperationError extends Schema.TaggedErrorClass<AgentAwarenessOperationError>()(
  "AgentAwarenessOperationError",
  {
    operation: AgentAwarenessOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Agent awareness operation ${this.operation} failed.`;
  }
}

const environmentConnections = new Map<EnvironmentId, SavedRemoteConnection>();
const activityPushTokenListeners = new WeakSet<LiveActivity<AgentActivityProps>>();
// Activity tokens the relay recently accepted, by acceptance time. The refresh
// runs on sign-in, every app foreground, and every environment-connection
// update, which arrive in bursts and spammed identical registrations. But the
// registration is not a pure no-op: the relay replays the current aggregate to
// this device on every accepted registration, and that replay is the
// foreground reconciliation that repairs drifted or orphaned activities. So
// dedupe only within a short window — bursts collapse to one request, while a
// foreground after real time away still triggers a replay. Cleared on
// sign-out/identity change alongside the device registration state.
const ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS = 60_000;
const registeredActivityPushTokens = new Map<string, number>();
let pushTokenSubscription: { remove: () => void } | null = null;
let appStateSubscription: { remove: () => void } | null = null;

// Whether the relay has actually accepted this device's registration. The
// notification/Live Activity settings toggles must reflect this rather than
// only local iOS permission or saved preferences: if the registration request
// never succeeded, the device cannot receive anything, so the switches must
// not read as enabled.
export type AgentAwarenessRegistrationStatus = "unknown" | "pending" | "registered" | "failed";
let registrationStatus: AgentAwarenessRegistrationStatus = "unknown";
const registrationStatusListeners = new Set<() => void>();

function setRegistrationStatus(next: AgentAwarenessRegistrationStatus): void {
  if (registrationStatus === next) {
    return;
  }
  registrationStatus = next;
  for (const listener of registrationStatusListeners) {
    listener();
  }
}

export function getAgentAwarenessRegistrationStatus(): AgentAwarenessRegistrationStatus {
  return registrationStatus;
}

export function subscribeAgentAwarenessRegistrationStatus(listener: () => void): () => void {
  registrationStatusListeners.add(listener);
  return () => {
    registrationStatusListeners.delete(listener);
  };
}
let activeLiveActivityRegistrationRetry: ReturnType<typeof setTimeout> | null = null;
let relayTokenProvider: (() => Promise<string | null>) | null = null;
let relayTokenProviderIdentity: string | null = null;
let deviceRegistrationGeneration = 0;
let activeDeviceRegistration: {
  readonly input: DeviceRegistrationInput;
  operation: Promise<void>;
} | null = null;
let pendingDeviceRegistration: {
  readonly input: DeviceRegistrationInput;
  readonly context: string;
} | null = null;

interface DeviceRegistrationInput {
  readonly observedPushToken?: string;
}

interface RegisterDeviceInput extends DeviceRegistrationInput {
  readonly preferencesOverride?: Partial<Preferences>;
}

export function mergeAgentAwarenessRegistrationPreferences(
  stored: Preferences,
  override: Partial<Preferences> | undefined,
): Preferences {
  return { ...stored, ...override };
}

export function normalizeAgentAwarenessRelayBaseUrl(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/g, "");
}

function readRelayConfig(): { readonly url: string } | null {
  const relayUrl = resolveCloudPublicConfig().relay.url;
  if (!relayUrl) {
    logRegistrationDebug("relay registration skipped; relay config missing");
    return null;
  }

  return { url: relayUrl };
}

function canRegisterRemoteLiveActivities(): boolean {
  return Platform.OS === "ios";
}

export function shouldRegisterAgentAwarenessDeviceForProvider(
  previousIdentity: string | null,
  identity: string | undefined,
): boolean {
  return identity === undefined || identity !== previousIdentity;
}

export function setAgentAwarenessRelayTokenProvider(
  provider: (() => Promise<string | null>) | null,
  identity?: string,
): void {
  const isExistingIdentity =
    provider !== null &&
    !shouldRegisterAgentAwarenessDeviceForProvider(relayTokenProviderIdentity, identity);
  if (!isExistingIdentity) {
    deviceRegistrationGeneration++;
    activeDeviceRegistration = null;
    pendingDeviceRegistration = null;
    registeredActivityPushTokens.clear();
  }
  relayTokenProvider = provider;
  relayTokenProviderIdentity = provider ? (identity ?? null) : null;
  if (!provider) {
    pushTokenSubscription?.remove();
    pushTokenSubscription = null;
    appStateSubscription?.remove();
    appStateSubscription = null;
    if (activeLiveActivityRegistrationRetry) {
      clearTimeout(activeLiveActivityRegistrationRetry);
      activeLiveActivityRegistrationRetry = null;
    }
    // Without a signed-in user the relay can no longer update or end these
    // activities, so they would sit orphaned on the lock screen.
    endLocalLiveActivities("live activity cleanup after cloud sign-out failed");
    setRegistrationStatus("unknown");
    // Sign-out is the only thing that invalidates a stored registration, so the
    // next sign-in re-registers.
    void clearAgentAwarenessRegistrationRecord().catch((error: unknown) => {
      logRegistrationError("clear registration record on sign-out failed", error);
    });
    return;
  }
  ensurePushTokenListener();
  ensureAppStateListener();
  runRegistrationInBackground(
    refreshActiveLiveActivityRemoteRegistration(),
    "active live activity registration after cloud sign-in failed",
  );
  if (isExistingIdentity) {
    // Same account re-activating (e.g. Clerk token refresh) normally needs no
    // re-registration — but if the previous attempt never succeeded, this is
    // the only trigger that will retry it before the next cold start.
    if (registrationStatus !== "registered") {
      enqueueDeviceRegistration({}, "device registration retry after cloud session refresh failed");
    }
    return;
  }
  enqueueDeviceRegistration({}, "device registration after cloud sign-in failed");
}

// Detach the provider and native listeners without the destructive sign-out
// cleanup. For provider teardown while the user is still signed in (e.g. the
// auth bridge unmounting/remounting), ending lock-screen activities and wiping
// the persisted registration would be wrong — the relay still holds a valid
// registration and the next mount reuses it.
export function releaseAgentAwarenessRelayTokenProvider(): void {
  relayTokenProvider = null;
  relayTokenProviderIdentity = null;
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  if (activeLiveActivityRegistrationRetry) {
    clearTimeout(activeLiveActivityRegistrationRetry);
    activeLiveActivityRegistrationRetry = null;
  }
}

function iosMajorVersion(): number {
  const version = Platform.Version;
  if (typeof version === "number") {
    return Math.floor(version);
  }
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 18;
}

function nativePushTokenRegistration(observedPushToken?: string) {
  return Effect.gen(function* () {
    if (!canRegisterRemoteLiveActivities() || !supportsAgentAwarenessPush()) {
      return { notificationsEnabled: false, pushToken: null };
    }
    if (observedPushToken) {
      return { notificationsEnabled: true, pushToken: observedPushToken };
    }
    const permissions = yield* Effect.tryPromise({
      try: () => Notifications.getPermissionsAsync(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-notification-permissions",
          cause,
        }),
    });
    if (!permissions.granted) {
      return { notificationsEnabled: false, pushToken: null };
    }
    const token = yield* Effect.tryPromise({
      try: () => Notifications.getDevicePushTokenAsync(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-native-push-token",
          cause,
        }),
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          logRegistrationError("native APNs token lookup failed", error);
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    const pushToken =
      token?.type === "ios" && typeof token.data === "string" && token.data.trim().length > 0
        ? token.data.trim()
        : null;
    return { notificationsEnabled: pushToken !== null, pushToken };
  });
}

const relayToken = (
  operation: "read-device-registration-relay-token" | "read-live-activity-registration-relay-token",
) =>
  Effect.gen(function* () {
    const provider = relayTokenProvider;
    if (!provider) {
      return null;
    }
    return yield* Effect.tryPromise({
      try: provider,
      catch: (cause) => new AgentAwarenessOperationError({ operation, cause }),
    });
  });

// Stable fingerprint of everything the relay stores for this device. When it
// matches the last accepted registration for the same account, re-registering
// is a no-op, so a launch that changed nothing skips the request entirely.
function registrationSignature(body: RelayDeviceRegistrationRequest): string {
  return [
    body.deviceId,
    body.pushToken ?? "",
    body.bundleId ?? "",
    body.apsEnvironment ?? "",
    body.appVersion ?? "",
    body.label,
    body.iosMajorVersion,
    body.preferences.notificationsEnabled,
    body.preferences.liveActivitiesEnabled,
    body.preferences.notifyOnApproval,
    body.preferences.notifyOnInput,
    body.preferences.notifyOnCompletion,
    body.preferences.notifyOnFailure,
  ].join("|");
}

function registerDeviceWithRelay(
  body: RelayDeviceRegistrationRequest,
  expectedGeneration: number,
): Effect.Effect<void, unknown, ManagedRelay.ManagedRelayClient> {
  return Effect.gen(function* () {
    if (expectedGeneration !== deviceRegistrationGeneration) {
      logRegistrationDebug("device registration cancelled before relay request", {
        expectedGeneration,
        currentGeneration: deviceRegistrationGeneration,
      });
      return;
    }
    const relayConfig = readRelayConfig();
    if (!relayConfig) {
      // Nothing is in flight and nothing can succeed until configuration
      // appears; "pending" would otherwise stick forever.
      setRegistrationStatus("unknown");
      return;
    }
    const token = yield* relayToken("read-device-registration-relay-token");
    if (expectedGeneration !== deviceRegistrationGeneration) {
      logRegistrationDebug("device registration cancelled after auth lookup", {
        expectedGeneration,
        currentGeneration: deviceRegistrationGeneration,
      });
      return;
    }
    if (!token) {
      logRegistrationDebug("relay device registration skipped; user is not signed in");
      setRegistrationStatus("unknown");
      return;
    }

    // Skip the request when this account already registered an identical
    // payload; the relay upsert would be a no-op. The record is only cleared on
    // sign-out, so a device stays registered across launches without re-hitting
    // the relay every time the app opens.
    const identity = relayTokenProviderIdentity ?? "";
    const persisted = yield* Effect.tryPromise({
      try: () => loadAgentAwarenessRegistrationRecord(),
      catch: (cause) => cause,
    }).pipe(Effect.orElseSucceed(() => null));
    if (expectedGeneration !== deviceRegistrationGeneration) {
      // Signed out while the record loaded — do not resurrect the cleared
      // record or report the previous account's registration as current.
      logRegistrationDebug("device registration cancelled after record lookup", {
        expectedGeneration,
        currentGeneration: deviceRegistrationGeneration,
      });
      return;
    }
    const payload = body;
    // The relay URL participates so pointing the app at a different relay
    // invalidates the record and re-registers there.
    const signature = `${relayConfig.url}|${registrationSignature(payload)}`;
    if (persisted && persisted.identity === identity && persisted.signature === signature) {
      setRegistrationStatus("registered");
      logRegistrationDebug("relay device registration skipped; already registered for account", {
        expectedGeneration,
      });
      return;
    }

    const client = yield* ManagedRelay.ManagedRelayClient;
    logRegistrationDebug("relay device registration request started", {
      expectedGeneration,
    });
    yield* client.registerDevice({
      clerkToken: token,
      payload,
    });
    if (expectedGeneration !== deviceRegistrationGeneration) {
      // Signed out while the request was in flight: the sign-out path already
      // reset the status and cleared the record for the next account, so a
      // stale success must not overwrite either.
      logRegistrationDebug("device registration completed after sign-out; result discarded", {
        expectedGeneration,
        currentGeneration: deviceRegistrationGeneration,
      });
      return;
    }
    setRegistrationStatus("registered");
    yield* Effect.promise(() =>
      saveAgentAwarenessRegistrationRecord({
        identity,
        signature,
      }).catch((error: unknown) => {
        logRegistrationError("persist registration record failed", error);
      }),
    );
    logRegistrationDebug("relay device registration request completed", {
      expectedGeneration,
    });
  });
}

function unregisterDeviceWithRelay(input: {
  readonly deviceId: string;
  readonly tokenProvider: () => Promise<string | null>;
}): Effect.Effect<void, unknown, ManagedRelay.ManagedRelayClient> {
  return Effect.gen(function* () {
    if (!readRelayConfig()) return;
    const token = yield* Effect.tryPromise({
      try: input.tokenProvider,
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-device-unregistration-relay-token",
          cause,
        }),
    });
    if (!token) {
      logRegistrationDebug("relay device unregistration skipped; user is not signed in");
      return;
    }

    const client = yield* ManagedRelay.ManagedRelayClient;
    yield* client.unregisterDevice({
      clerkToken: token,
      deviceId: input.deviceId,
    });
  });
}

// Arms the lock-screen card the moment the user starts agent work from this
// phone, while the app is still foregrounded and the fresh activity's token
// can be registered immediately. The seeded row is a best-effort placeholder;
// the relay's registration replay repaints it with the authoritative
// aggregate within seconds. No-ops when a card is already armed.
export function armAgentAwarenessLiveActivityForLocalWork(input: {
  readonly threadTitle: string;
  readonly projectTitle: string;
}): void {
  if (!canRegisterRemoteLiveActivities() || !relayTokenProvider) {
    return;
  }
  void loadPreferences()
    .catch(() => null)
    .then((preferences) => {
      if (preferences?.liveActivitiesEnabled === false) {
        return;
      }
      armAgentAwarenessLiveActivityForLocalWorkNow(input);
    });
}

function armAgentAwarenessLiveActivityForLocalWorkNow(input: {
  readonly threadTitle: string;
  readonly projectTitle: string;
}): void {
  try {
    if (AgentActivity.getInstances().length > 0) {
      return;
    }
    const nowIso = new Date(Date.now()).toISOString();
    const activity = AgentActivity.start({
      title: "T3 Code",
      subtitle: "Agent work in progress",
      activeCount: 1,
      updatedAt: nowIso,
      activities: [
        {
          environmentId: "",
          threadId: "",
          projectTitle: input.projectTitle,
          threadTitle: input.threadTitle,
          modelTitle: "",
          phase: "starting",
          status: "Connecting",
          updatedAt: nowIso,
          deepLink: "/",
        },
      ],
    });
    logRegistrationDebug("live activity card armed for local work", {
      threadTitle: input.threadTitle,
    });
    runRegistrationInBackground(
      registerLiveActivityPushToken({ activity }).pipe(Effect.asVoid),
      "live activity arming after local task start failed",
    );
  } catch (error) {
    logRegistrationError("live activity arming failed", error);
  }
}

function readAgentActivitySnapshot(): Effect.Effect<
  RelayAgentActivitySnapshotResponse | null,
  never,
  ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    if (!readRelayConfig()) return null;
    const token = yield* relayToken("read-live-activity-registration-relay-token");
    if (!token) {
      return null;
    }
    const client = yield* ManagedRelay.ManagedRelayClient;
    return yield* client.getAgentActivitySnapshot({ clerkToken: token });
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logRegistrationError("agent activity snapshot read failed", error);
        return null;
      }),
    ),
  );
}

function registerLiveActivityWithRelay(
  body: RelayLiveActivityRegistrationRequest,
): Effect.Effect<boolean, unknown, ManagedRelay.ManagedRelayClient> {
  return Effect.gen(function* () {
    if (!readRelayConfig()) return false;
    const token = yield* relayToken("read-live-activity-registration-relay-token");
    if (!token) {
      logRegistrationDebug("relay live activity registration skipped; user is not signed in");
      return false;
    }

    const client = yield* ManagedRelay.ManagedRelayClient;
    yield* client.registerLiveActivity({
      clerkToken: token,
      payload: body,
    });
    return true;
  });
}

function logRegistrationError(context: string, error: unknown): void {
  if (!__DEV__) {
    return;
  }
  console.warn(`[agent-awareness] ${context}`, {
    message: error instanceof Error ? error.message : String(error),
    traceId: findErrorTraceId(error),
    error,
  });
}

function logRegistrationDebug(context: string, details?: unknown): void {
  if (!__DEV__) {
    return;
  }
  console.log(`[agent-awareness] ${context}`, details ?? "");
}

function runRegistrationInBackground(
  operation: Effect.Effect<unknown, unknown, ManagedRelay.ManagedRelayClient>,
  context: string,
): void {
  void (async () => {
    const result = await settleAsyncResult(() => runtime.runPromiseExit(operation));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      logRegistrationError(context, squashAtomCommandFailure(result));
    }
  })();
}

function mergeDeviceRegistrationInput(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): DeviceRegistrationInput {
  const observedPushToken = next.observedPushToken ?? current.observedPushToken;
  return observedPushToken ? { observedPushToken } : {};
}

function registrationAddsInformation(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): boolean {
  return (
    next.observedPushToken !== undefined && next.observedPushToken !== current.observedPushToken
  );
}

function startPendingDeviceRegistration(): void {
  if (activeDeviceRegistration || !pendingDeviceRegistration) {
    return;
  }

  const next = pendingDeviceRegistration;
  pendingDeviceRegistration = null;
  const generation = deviceRegistrationGeneration;
  logRegistrationDebug("device registration started", {
    generation,
    hasObservedPushToken: next.input.observedPushToken !== undefined,
  });
  if (registrationStatus !== "registered") {
    setRegistrationStatus("pending");
  }
  const registration = {
    input: next.input,
    operation: Promise.resolve(),
  };
  activeDeviceRegistration = registration;
  registration.operation = (async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(registerDevice(next.input, generation)),
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      // A transient failure on a later refresh (e.g. token rotation) leaves
      // the prior accepted registration intact on the relay, so an already
      // registered device stays "registered" rather than flipping the
      // settings toggles off.
      if (registrationStatus !== "registered") {
        setRegistrationStatus("failed");
      }
      logRegistrationError(next.context, squashAtomCommandFailure(result));
    }
    logRegistrationDebug("device registration finished", { generation });
    if (activeDeviceRegistration === registration) {
      activeDeviceRegistration = null;
    }
    startPendingDeviceRegistration();
  })();
}

function enqueueDeviceRegistration(input: DeviceRegistrationInput, context: string): void {
  if (
    activeDeviceRegistration &&
    !registrationAddsInformation(activeDeviceRegistration.input, input)
  ) {
    logRegistrationDebug("device registration coalesced with active request", {
      generation: deviceRegistrationGeneration,
    });
    return;
  }

  logRegistrationDebug("device registration enqueued", {
    generation: deviceRegistrationGeneration,
    hasActiveRegistration: activeDeviceRegistration !== null,
    hasPendingRegistration: pendingDeviceRegistration !== null,
  });
  pendingDeviceRegistration = pendingDeviceRegistration
    ? {
        input: mergeDeviceRegistrationInput(pendingDeviceRegistration.input, input),
        context,
      }
    : { input, context };
  startPendingDeviceRegistration();
}

function registerDevice(
  input: RegisterDeviceInput = {},
  expectedGeneration = deviceRegistrationGeneration,
): Effect.Effect<void, unknown, ManagedRelay.ManagedRelayClient> {
  return Effect.gen(function* () {
    if (!canRegisterRemoteLiveActivities()) {
      logRegistrationDebug("device registration skipped; platform does not support it");
      return;
    }

    logRegistrationDebug("device registration loading local state", { expectedGeneration });
    const [deviceId, storedPreferences] = yield* Effect.all([
      Effect.tryPromise({
        try: () => loadOrCreateAgentAwarenessDeviceId(),
        catch: (cause) =>
          new AgentAwarenessOperationError({
            operation: "load-device-registration-identifier",
            cause,
          }),
      }),
      Effect.tryPromise({
        try: () => loadPreferences(),
        catch: (cause) =>
          new AgentAwarenessOperationError({
            operation: "load-device-registration-preferences",
            cause,
          }),
      }),
    ]);
    const preferences = mergeAgentAwarenessRegistrationPreferences(
      storedPreferences,
      input.preferencesOverride,
    );
    const pushTokenRegistration = yield* nativePushTokenRegistration(input?.observedPushToken);
    logRegistrationDebug("device registration local state ready", {
      expectedGeneration,
      notificationsEnabled: pushTokenRegistration.notificationsEnabled,
    });
    const bundleId = Constants.expoConfig?.ios?.bundleIdentifier?.trim();
    yield* registerDeviceWithRelay(
      makeRelayDeviceRegistrationRequest({
        deviceId,
        label: Constants.deviceName?.trim() || "iOS device",
        iosMajorVersion: iosMajorVersion(),
        appVersion: Constants.expoConfig?.version,
        ...(bundleId ? { bundleId } : {}),
        apsEnvironment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant),
        ...(pushTokenRegistration.pushToken ? { pushToken: pushTokenRegistration.pushToken } : {}),
        notificationsEnabled: pushTokenRegistration.notificationsEnabled,
        preferences,
      }),
      expectedGeneration,
    );
  });
}

function registerDeviceForCurrentUser(): Effect.Effect<
  void,
  unknown,
  ManagedRelay.ManagedRelayClient
> {
  return registerDevice(undefined);
}

function ensurePushTokenListener(): void {
  if (pushTokenSubscription || !canRegisterRemoteLiveActivities()) {
    return;
  }

  pushTokenSubscription = Notifications.addPushTokenListener((token) => {
    if (token.type === "ios" && typeof token.data === "string" && token.data.trim().length > 0) {
      enqueueDeviceRegistration(
        { observedPushToken: token.data.trim() },
        "native APNs token rotation registration failed",
      );
    }
  });
}

// Re-registering activity tokens on foreground makes the relay replay the
// current aggregate to this device, which updates content that drifted while
// pushes could not be delivered and ends orphaned activities whose end push
// never arrived. (Deduped by ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS: rapid
// foreground/sign-in bursts collapse to one registration, but returning after
// real time away still replays.)
function ensureAppStateListener(): void {
  if (appStateSubscription || !canRegisterRemoteLiveActivities()) {
    return;
  }

  appStateSubscription = AppState.addEventListener("change", (state) => {
    if (state !== "active") {
      return;
    }
    runRegistrationInBackground(
      refreshActiveLiveActivityRemoteRegistration(),
      "active live activity reconciliation after app foreground failed",
    );
  });
}

function endLocalLiveActivities(context: string): void {
  if (!canRegisterRemoteLiveActivities()) {
    return;
  }
  try {
    for (const activity of AgentActivity.getInstances()) {
      activity.end("immediate").catch((error: unknown) => {
        logRegistrationError(context, error);
      });
    }
  } catch (error) {
    logRegistrationError(context, error);
  }
}

export function registerAgentAwarenessConnection(connection: SavedRemoteConnection): void {
  if (!canRegisterRemoteLiveActivities()) {
    return;
  }

  environmentConnections.set(connection.environmentId, connection);
  ensurePushTokenListener();
  ensureAppStateListener();
  enqueueDeviceRegistration({}, "device registration failed");
  runRegistrationInBackground(
    refreshActiveLiveActivityRemoteRegistration(),
    "active live activity registration after environment connection failed",
  );
}

function removeAgentAwarenessConnection(environmentId: EnvironmentId): void {
  environmentConnections.delete(environmentId);
}

export function unregisterAgentAwarenessConnection(environmentId: EnvironmentId): void {
  removeAgentAwarenessConnection(environmentId);
}

export function unregisterAllAgentAwarenessConnections(): void {
  environmentConnections.clear();
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  if (activeLiveActivityRegistrationRetry) {
    clearTimeout(activeLiveActivityRegistrationRetry);
    activeLiveActivityRegistrationRetry = null;
  }
}

export function refreshAgentAwarenessRegistration(): Effect.Effect<
  void,
  never,
  ManagedRelay.ManagedRelayClient
> {
  return registerDeviceForCurrentUser().pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        // Same rationale as the queued path: a failed refresh does not undo an
        // already accepted registration.
        if (registrationStatus !== "registered") {
          setRegistrationStatus("failed");
        }
        logRegistrationError("device registration refresh failed", error);
      }),
    ),
  );
}

export function updateAgentAwarenessRegistrationPreferences(
  preferencesOverride: Partial<Preferences>,
): Effect.Effect<void, unknown, ManagedRelay.ManagedRelayClient> {
  return registerDevice({ preferencesOverride }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        if (registrationStatus !== "registered") {
          setRegistrationStatus("failed");
        }
        logRegistrationError("device preference registration refresh failed", error);
      }),
    ),
  );
}

export function __resetAgentAwarenessRemoteRegistrationForTest(): void {
  environmentConnections.clear();
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  if (activeLiveActivityRegistrationRetry) {
    clearTimeout(activeLiveActivityRegistrationRetry);
    activeLiveActivityRegistrationRetry = null;
  }
  relayTokenProvider = null;
  relayTokenProviderIdentity = null;
  deviceRegistrationGeneration++;
  activeDeviceRegistration = null;
  pendingDeviceRegistration = null;
  registrationStatus = "unknown";
  registrationStatusListeners.clear();
  registeredActivityPushTokens.clear();
}

export function unregisterAgentAwarenessDeviceForCurrentUser(
  tokenProvider: () => Promise<string | null>,
): Effect.Effect<void, never, ManagedRelay.ManagedRelayClient> {
  return Effect.gen(function* () {
    const deviceId = yield* Effect.tryPromise({
      try: () => loadAgentAwarenessDeviceId(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-device-unregistration-identifier",
          cause,
        }),
    });
    if (!deviceId) {
      return;
    }
    yield* unregisterDeviceWithRelay({ deviceId, tokenProvider });
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logRegistrationError("device unregistration failed", error);
      }),
    ),
  );
}

export function registerLiveActivityPushToken(input: {
  readonly activity: LiveActivity<AgentActivityProps>;
}): Effect.Effect<boolean, unknown, ManagedRelay.ManagedRelayClient> {
  return Effect.gen(function* () {
    if (!canRegisterRemoteLiveActivities()) {
      return false;
    }

    const activityPushToken = yield* Effect.tryPromise({
      try: () => input.activity.getPushToken(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-live-activity-push-token",
          cause,
        }),
    });
    if (!activityPushToken) {
      if (activityPushTokenListeners.has(input.activity)) {
        logRegistrationDebug(
          "live activity push token not available yet; token listener already registered",
          {
            connectionCount: environmentConnections.size,
          },
        );
        return false;
      }

      logRegistrationDebug(
        "live activity push token not available yet; listening for token event",
        {
          connectionCount: environmentConnections.size,
        },
      );
      activityPushTokenListeners.add(input.activity);
      input.activity.addPushTokenListener((event) => {
        if (event.pushToken) {
          logRegistrationDebug("live activity push token event received", {
            tokenSuffix: event.pushToken.slice(-8),
          });
          runRegistrationInBackground(
            registerLiveActivityPushTokenValue({
              activityPushToken: event.pushToken,
            }),
            "live activity token listener registration failed",
          );
        }
      });
      return false;
    }

    return yield* registerLiveActivityPushTokenValue({
      activityPushToken,
    });
  });
}

function registerLiveActivityPushTokenValue(input: {
  readonly activityPushToken: string;
}): Effect.Effect<boolean, unknown, ManagedRelay.ManagedRelayClient> {
  return Effect.gen(function* () {
    const acceptedAt = registeredActivityPushTokens.get(input.activityPushToken);
    if (
      acceptedAt !== undefined &&
      Date.now() - acceptedAt < ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS
    ) {
      return true;
    }
    const deviceId = yield* Effect.tryPromise({
      try: () => loadOrCreateAgentAwarenessDeviceId(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-live-activity-registration-identifier",
          cause,
        }),
    });
    const registered = yield* registerLiveActivityWithRelay({
      deviceId,
      activityPushToken: input.activityPushToken,
    });
    if (registered) {
      registeredActivityPushTokens.set(input.activityPushToken, Date.now());
      logRegistrationDebug("live activity push token registered", {
        tokenSuffix: input.activityPushToken.slice(-8),
      });
    }
    return registered;
  });
}

function scheduleActiveLiveActivityRegistrationRetry(): void {
  if (activeLiveActivityRegistrationRetry || !relayTokenProvider) {
    return;
  }

  activeLiveActivityRegistrationRetry = setTimeout(() => {
    activeLiveActivityRegistrationRetry = null;
    runRegistrationInBackground(
      refreshActiveLiveActivityRemoteRegistration(),
      "active live activity token retry failed",
    );
  }, REMOTE_ACTIVITY_REGISTRATION_RETRY_MS);
}

export function refreshActiveLiveActivityRemoteRegistration(): Effect.Effect<
  void,
  never,
  ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    if (!canRegisterRemoteLiveActivities() || !relayTokenProvider) {
      return;
    }

    let activities = yield* Effect.try({
      try: () => AgentActivity.getInstances(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "list-active-live-activities",
          cause,
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          logRegistrationError("active live activity lookup failed", error);
          return [] as ReadonlyArray<LiveActivity<AgentActivityProps>>;
        }),
      ),
    );

    // The relay tracks exactly one card per device; if concurrent arming ever
    // produced extras, end them so only one keeps receiving updates.
    if (activities.length > 1) {
      for (const extra of activities.slice(1)) {
        extra.end("immediate").catch((error: unknown) => {
          logRegistrationError("duplicate live activity cleanup failed", error);
        });
      }
      activities = activities.slice(0, 1);
    }

    // Activities are only ever created here, in the foreground, where the
    // update token can be observed and registered immediately — the relay
    // never remote-starts one (background push-to-start wakes proved too
    // unreliable to hand the token over). Arming is conditional: the relay is
    // asked what the card would show first, so an idle open never creates an
    // empty lock-screen card, and an armed card is born with the real
    // aggregate instead of a placeholder.
    if (activities.length === 0) {
      const preferences = yield* Effect.tryPromise({
        try: () => loadPreferences(),
        catch: (cause) =>
          new AgentAwarenessOperationError({
            operation: "load-live-activity-prime-preferences",
            cause,
          }),
      }).pipe(Effect.orElseSucceed(() => null));
      // The toggle defaults to on: an unset preference (fresh install) must
      // prime, so only an explicit false blocks it.
      if (preferences?.liveActivitiesEnabled !== false) {
        const snapshot = yield* readAgentActivitySnapshot();
        // The snapshot request yields; an arm-on-send may have created the
        // card in the meantime. Re-check so two cards are never started.
        const armedMeanwhile = yield* Effect.try({
          try: () => AgentActivity.getInstances(),
          catch: () => [] as ReadonlyArray<LiveActivity<AgentActivityProps>>,
        }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<LiveActivity<AgentActivityProps>>));
        if (armedMeanwhile.length > 0) {
          activities = [...armedMeanwhile];
        } else if (snapshot?.aggregate && snapshot.aggregate.activeCount > 0) {
          const aggregate = snapshot.aggregate;
          const primed = yield* Effect.try({
            try: () =>
              AgentActivity.start({
                title: aggregate.title,
                subtitle: aggregate.subtitle,
                activeCount: aggregate.activeCount,
                updatedAt: aggregate.updatedAt,
                activities: aggregate.activities,
              }),
            catch: (cause) =>
              new AgentAwarenessOperationError({
                operation: "prime-live-activity",
                cause,
              }),
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                logRegistrationError("live activity priming failed", error);
                return null;
              }),
            ),
          );
          if (primed) {
            logRegistrationDebug("live activity card primed", {
              activeCount: aggregate.activeCount,
            });
            activities = [primed];
          }
        }
      }
    }

    const registrationResults = yield* Effect.forEach(activities, (activity) =>
      registerLiveActivityPushToken({ activity }).pipe(
        Effect.map((registered) => !registered),
        Effect.catch((error) =>
          Effect.sync(() => {
            logRegistrationError("active live activity token registration failed", error);
            return true;
          }),
        ),
      ),
    );

    if (registrationResults.some(Boolean)) {
      scheduleActiveLiveActivityRegistrationRetry();
    }
  });
}
