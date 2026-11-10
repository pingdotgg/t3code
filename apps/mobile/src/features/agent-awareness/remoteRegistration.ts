import { type LiveActivity } from "expo-widgets";
import {
  configureAndroidAgentNotifications,
  clearAndroidAgentNotifications,
} from "./androidNotifications";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AppState, Platform } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
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

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentCatalog } from "../../connection/catalog";
import { environmentShell } from "../../state/shell";
import { environmentServerConfigsAtom } from "../../state/server";
import type { Preferences } from "../../persistence/mobile-preferences";
import {
  clearAgentAwarenessRegistrationRecord,
  loadAgentAwarenessDeviceId,
  loadAgentAwarenessRegistrationRecord,
  loadOrCreateAgentAwarenessDeviceId,
  loadPreferences,
  saveAgentAwarenessRegistrationRecord,
} from "../../persistence/imperative";
import type { AgentActivityProps } from "../../widgets/AgentActivity";
import { AGENT_ACTIVITY_FRESHNESS_MS } from "../../widgets/agentActivityTimeline";
import {
  dismissEndedAgentLiveActivities,
  getAgentLiveActivities,
  publishAgentActivityWidget,
  startAgentLiveActivity,
} from "./agentLiveActivity";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { supportsAgentAwarenessPush } from "./capabilities";
import {
  agentWidgetToken,
  configureAgentWidgetRefresh,
  clearAgentWidgetRefresh,
} from "./agentWidgetRefresh";
import { makeRelayDeviceRegistrationRequest, resolveApsEnvironment } from "./registrationPayload";
import {
  createLiveWidgetActivitiesAtom,
  reconcileWidgetActivity,
  retainUnconfirmedWidgetActivities,
  sameWidgetEnvironmentScope,
  type LiveWidgetActivities,
} from "./liveWidgetActivity";

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
  "load-registration-record",
]);

export class AgentAwarenessOperationError extends Schema.TaggedError<AgentAwarenessOperationError>()(
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

export type AgentAwarenessRegistrationError =
  | AgentAwarenessOperationError
  | ManagedRelay.ManagedRelayClientError;

// ActivityKit returns new wrappers per id; serialize by id to prevent stale-token registration.
const activityPushTokenLocks = new Map<string, Semaphore.Semaphore>();
// Each accepted registration replays the relay aggregate, repairing drifted or orphaned activities.
const ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS = 60_000;
// Match the relay's STALE_AFTER_SECONDS so activities expire even if registration fails.
const LIVE_ACTIVITY_STALE_AFTER_MS = 10 * 60_000;
const liveActivityStaleDate = () => new Date(Date.now() + LIVE_ACTIVITY_STALE_AFTER_MS);
const registeredActivityPushTokens = new Map<string, number>();
let androidDeviceReplayedAt: number | null = null;
let pushTokenSubscription: { remove: () => void } | null = null;
let appStateSubscription: { remove: () => void } | null = null;

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
let widgetRefreshGeneration = 0;
const liveWidgetActivitiesAtom = createLiveWidgetActivitiesAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
  now: () => Date.now(),
});
let liveWidgetSubscription: (() => void) | null = null;
let liveWidgetActivities: LiveWidgetActivities = new Map();
let observedWidgetActivities: LiveWidgetActivities = new Map();
let relayWidgetSnapshot: RelayAgentActivitySnapshotResponse | null = null;
let relayWidgetConfirmedAt: number | null = null;
const widgetShellObservations = new Map<EnvironmentId, EnvironmentShellState>();
const widgetShellConfirmedAt = new Map<EnvironmentId, number>();
let publishedWidgetContent: string | null = null;
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

function mergeAgentAwarenessRegistrationPreferences(
  stored: Preferences,
  override: Partial<Preferences> | undefined,
): Preferences {
  return { ...stored, ...override };
}

function readRelayConfig(): { readonly url: string } | null {
  const relayUrl = resolveCloudPublicConfig().relay.url;
  if (!relayUrl) {
    return null;
  }

  return { url: relayUrl };
}

function canRegisterRemoteLiveActivities(): boolean {
  return Platform.OS === "ios";
}

function canRegisterPushNotifications(): boolean {
  return Platform.OS === "ios" || Platform.OS === "android";
}

function shouldRegisterAgentAwarenessDeviceForProvider(
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
    // An unset JS identity may mean remount; native configure checks the persisted account on cold start.
    if (relayTokenProviderIdentity && identity !== relayTokenProviderIdentity) {
      clearAndroidAgentNotifications();
      if (provider) clearAgentWidgetRefresh();
    }
    androidDeviceReplayedAt = null;
    stopLiveWidgetObserver();
    relayWidgetSnapshot = null;
    relayWidgetConfirmedAt = null;
    deviceRegistrationGeneration++;
    activeDeviceRegistration = null;
    pendingDeviceRegistration = null;
    registeredActivityPushTokens.clear();
  }
  relayTokenProvider = provider;
  relayTokenProviderIdentity = provider ? (identity ?? null) : null;
  if (!provider) {
    clearAndroidAgentNotifications();
    clearAgentWidgetRefresh();
    pushTokenSubscription?.remove();
    pushTokenSubscription = null;
    appStateSubscription?.remove();
    appStateSubscription = null;
    if (activeLiveActivityRegistrationRetry) {
      clearTimeout(activeLiveActivityRegistrationRetry);
      activeLiveActivityRegistrationRetry = null;
    }
    // Signed-out activities would be orphaned because the relay can no longer update or end them.
    endLocalLiveActivities("live activity cleanup after cloud sign-out failed");
    publishRegularWidget(idleWidgetProps());
    setRegistrationStatus("unknown");
    void clearAgentAwarenessRegistrationRecord().catch((error: unknown) => {
      logRegistrationError("clear registration record on sign-out failed", error);
    });
    return;
  }
  // Native timelines survive JS restarts. Clear unowned content before a new
  // session publishes, even if its relay read fails. Token refreshes keep it.
  if (!isExistingIdentity) {
    // Compare the persisted native identity before any asynchronous registration
    // work; a cold JS runtime cannot otherwise identify the previous account.
    if (identity) agentWidgetToken(identity);
    publishedWidgetContent = null;
    publishRegularWidget(idleWidgetProps());
  }
  ensurePushTokenListener();
  ensureAppStateListener();
  startLiveWidgetObserver();
  runRegistrationInBackground(
    refreshActiveLiveActivityRemoteRegistration(),
    "active live activity registration after cloud sign-in failed",
  );
  if (isExistingIdentity) {
    if (registrationStatus !== "registered") {
      enqueueDeviceRegistration({}, "device registration retry after cloud session refresh failed");
    }
    return;
  }
  enqueueDeviceRegistration({}, "device registration after cloud sign-in failed");
}

// Provider remounts retain a valid relay registration; teardown must preserve it and lock-screen activities.
export function releaseAgentAwarenessRelayTokenProvider(): void {
  stopLiveWidgetObserver();
  relayWidgetSnapshot = null;
  relayWidgetConfirmedAt = null;
  relayTokenProvider = null;
  relayTokenProviderIdentity = null;
  deviceRegistrationGeneration++;
  activeDeviceRegistration = null;
  pendingDeviceRegistration = null;
  androidDeviceReplayedAt = null;
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

const nativePushTokenRegistration = Effect.fn("remoteRegistration.nativePushTokenRegistration")(
  function* (observedPushToken?: string) {
    if (!canRegisterPushNotifications() || !supportsAgentAwarenessPush()) {
      return { notificationsEnabled: false, pushToken: null, notificationPermissionGranted: false };
    }
    const permissions = yield* Effect.tryPromise({
      try: () => Notifications.getPermissionsAsync(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-notification-permissions",
          cause,
        }),
    });
    // Android FCM data delivery is independent of notification presentation permission.
    if (!permissions.granted && Platform.OS !== "android") {
      return { notificationsEnabled: false, pushToken: null, notificationPermissionGranted: false };
    }
    const alertsEnabled =
      permissions.granted &&
      (Platform.OS === "android" && Number(Platform.Version) >= 26
        ? yield* Effect.tryPromise({
            try: () => Notifications.getNotificationChannelAsync("agent-alerts"),
            catch: (cause) =>
              new AgentAwarenessOperationError({
                operation: "read-notification-permissions",
                cause,
              }),
          }).pipe(
            Effect.map((channel) => channel?.importance !== Notifications.AndroidImportance.NONE),
            Effect.orElseSucceed(() => false),
          )
        : true);
    if (observedPushToken) {
      return {
        notificationsEnabled: alertsEnabled,
        pushToken: observedPushToken,
        notificationPermissionGranted: permissions.granted,
      };
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
          logRegistrationError("native push token lookup failed", error);
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    const pushToken =
      token?.type === Platform.OS && typeof token.data === "string" && token.data.trim().length > 0
        ? token.data.trim()
        : null;
    return {
      notificationsEnabled: alertsEnabled && pushToken !== null,
      pushToken,
      notificationPermissionGranted: permissions.granted,
    };
  },
);

const relayToken = Effect.fn("remoteRegistration.relayToken")(function* (
  operation: "read-device-registration-relay-token" | "read-live-activity-registration-relay-token",
) {
  const provider = relayTokenProvider;
  if (!provider) {
    return null;
  }
  return yield* Effect.tryPromise({
    try: provider,
    catch: (cause) => new AgentAwarenessOperationError({ operation, cause }),
  });
});

function registrationSignature(body: RelayDeviceRegistrationRequest): string {
  return [
    body.deviceId,
    body.pushToken ?? "",
    body.widgetAccessToken ?? "",
    body.bundleId ?? "",
    body.apsEnvironment ?? "",
    body.appVersion ?? "",
    body.label,
    body.platform,
    body.iosMajorVersion,
    body.androidApiLevel,
    body.preferences.notificationsEnabled,
    body.preferences.liveActivitiesEnabled,
    body.preferences.notifyOnApproval,
    body.preferences.notifyOnInput,
    body.preferences.notifyOnCompletion,
    body.preferences.notifyOnFailure,
  ].join("|");
}

const registerDeviceWithRelay = Effect.fn("remoteRegistration.registerDeviceWithRelay")(function* (
  body: RelayDeviceRegistrationRequest,
  expectedGeneration: number,
): Effect.fn.Return<void, AgentAwarenessRegistrationError, ManagedRelay.ManagedRelayClient> {
  if (expectedGeneration !== deviceRegistrationGeneration) {
    return;
  }
  const relayConfig = readRelayConfig();
  if (!relayConfig) {
    setRegistrationStatus("unknown");
    return;
  }
  const token = yield* relayToken("read-device-registration-relay-token");
  if (expectedGeneration !== deviceRegistrationGeneration) {
    return;
  }
  if (!token) {
    setRegistrationStatus("unknown");
    return;
  }

  const identity = relayTokenProviderIdentity ?? "";
  const persisted = yield* Effect.tryPromise({
    try: () => loadAgentAwarenessRegistrationRecord(),
    catch: (cause) =>
      new AgentAwarenessOperationError({ operation: "load-registration-record", cause }),
  }).pipe(Effect.orElseSucceed(() => null));
  if (expectedGeneration !== deviceRegistrationGeneration) {
    // Signed out while the record loaded — do not resurrect the cleared
    // record or report the previous account's registration as current.
    return;
  }
  const widgetToken =
    Platform.OS === "ios" && supportsAgentAwarenessPush() && identity
      ? agentWidgetToken(identity)
      : null;
  // Persist the revocation URL before exposing this credential to the relay.
  if (widgetToken) configureAgentWidgetRefresh(relayConfig.url, widgetToken);
  const payload = widgetToken ? { ...body, widgetAccessToken: widgetToken } : body;
  // The relay URL participates so pointing the app at a different relay
  // invalidates the record and re-registers there.
  const signature = `${relayConfig.url}|${registrationSignature(payload)}`;
  // Android registration also silently replays the current card. Collapse
  // foreground bursts, but repair missed pushes on cold start or a return
  // after time away, just like re-registering an iOS activity token.
  const now = yield* Clock.currentTimeMillis;
  const needsAndroidReplay =
    body.platform === "android" &&
    (androidDeviceReplayedAt === null ||
      now - androidDeviceReplayedAt >= ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS);
  if (
    persisted &&
    persisted.identity === identity &&
    persisted.signature === signature &&
    !needsAndroidReplay
  ) {
    setRegistrationStatus("registered");
    return;
  }

  const client = yield* ManagedRelay.ManagedRelayClient;
  yield* client.registerDevice({
    clerkToken: token,
    payload,
  });
  if (expectedGeneration !== deviceRegistrationGeneration) {
    // Signed out while the request was in flight: the sign-out path already
    // reset the status and cleared the record for the next account, so a
    // stale success must not overwrite either.
    return;
  }
  if (body.platform === "android") androidDeviceReplayedAt = yield* Clock.currentTimeMillis;
  setRegistrationStatus("registered");
  yield* Effect.promise(() =>
    saveAgentAwarenessRegistrationRecord({
      identity,
      signature,
    }).catch((error: unknown) => {
      logRegistrationError("persist registration record failed", error);
    }),
  );
});

const unregisterDeviceWithRelay = Effect.fn("remoteRegistration.unregisterDeviceWithRelay")(
  function* (input: {
    readonly deviceId: string;
    readonly tokenProvider: () => Promise<string | null>;
  }): Effect.fn.Return<void, AgentAwarenessRegistrationError, ManagedRelay.ManagedRelayClient> {
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
      return;
    }

    const client = yield* ManagedRelay.ManagedRelayClient;
    yield* client.unregisterDevice({
      clerkToken: token,
      deviceId: input.deviceId,
    });
  },
);

function environmentPublishesAgentActivity(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .agentActivityPublishing !== false
  );
}

function widgetPropsFromAggregate(
  aggregate: NonNullable<RelayAgentActivitySnapshotResponse["aggregate"]>,
): AgentActivityProps {
  return {
    title: aggregate.title,
    subtitle: aggregate.subtitle,
    activeCount: aggregate.activeCount,
    updatedAt: aggregate.updatedAt,
    activities: aggregate.activities,
  };
}

function idleWidgetProps(): AgentActivityProps {
  return {
    title: "T3 Code",
    subtitle: "No active agents",
    activeCount: 0,
    updatedAt: new Date().toISOString(),
    activities: [],
  };
}

function publishRegularWidget(props: AgentActivityProps): void {
  // Streaming text changes shell timestamps without changing widget content.
  const content = JSON.stringify({
    activeCount: props.activeCount,
    workingCount: props.workingCount,
    attentionCount: props.attentionCount,
    totalCount: props.totalCount,
    isStale: props.isStale,
    expiresAt: props.expiresAt === undefined ? undefined : Math.floor(props.expiresAt / 60_000),
    activities: props.activities.map(({ updatedAt: _updatedAt, ...row }) => row),
  });
  if (content === publishedWidgetContent) return;
  if (publishAgentActivityWidget(props)) publishedWidgetContent = content;
}

function publishReconciledWidget(): void {
  if (!relayTokenProvider) return;
  if (relayWidgetSnapshot === null && observedWidgetActivities.size === 0) return;
  const result = reconcileWidgetActivity(observedWidgetActivities, relayWidgetSnapshot);
  const confirmations = [...observedWidgetActivities.entries()]
    .filter(([, rows]) => rows.length > 0)
    .map(([id]) => widgetShellConfirmedAt.get(id) ?? 0);
  if (
    relayWidgetConfirmedAt !== null &&
    (relayWidgetSnapshot?.aggregate?.activities.length ?? 0) > 0
  )
    confirmations.push(relayWidgetConfirmedAt);
  const confirmedAt =
    confirmations.length > 0 ? Math.min(...confirmations) : (relayWidgetConfirmedAt ?? Date.now());
  publishRegularWidget({
    title: "T3 Code",
    subtitle:
      result.activeCount === null
        ? "Activity count unavailable"
        : result.activeCount > 0
          ? "Agent work in progress"
          : "No active agents",
    activeCount: result.activeCount,
    workingCount: result.workingCount,
    attentionCount: result.attentionCount,
    totalCount: result.totalCount,
    isStale: [...observedWidgetActivities.keys()].some((id) => !liveWidgetActivities.has(id)),
    expiresAt: confirmedAt + AGENT_ACTIVITY_FRESHNESS_MS,
    updatedAt: new Date().toISOString(),
    activities: result.activities,
  });
}

function stopLiveWidgetObserver(clearObservations = true): void {
  liveWidgetSubscription?.();
  liveWidgetSubscription = null;
  // Suspending observation does not disconnect a healthy environment. Keep
  // its last freshness state and let the native timeline expire it on time.
  if (clearObservations) {
    liveWidgetActivities = new Map();
    observedWidgetActivities = new Map();
    widgetShellObservations.clear();
    widgetShellConfirmedAt.clear();
  }
  widgetRefreshGeneration++;
}

function startLiveWidgetObserver(): void {
  if (
    liveWidgetSubscription ||
    !canRegisterRemoteLiveActivities() ||
    !relayTokenProvider ||
    AppState.currentState !== "active"
  )
    return;
  liveWidgetSubscription = appAtomRegistry.subscribe(
    liveWidgetActivitiesAtom,
    (activities) => {
      const previousScope = [...observedWidgetActivities.keys()];
      liveWidgetActivities = activities;
      const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
      const observed = new Map(observedWidgetActivities);
      for (const environmentId of observed.keys()) {
        if (catalog.entries.get(environmentId)?.enabled !== true) {
          observed.delete(environmentId);
          widgetShellObservations.delete(environmentId);
          widgetShellConfirmedAt.delete(environmentId);
        }
      }
      for (const [environmentId, rows] of activities) {
        const shell = appAtomRegistry.get(environmentShell.stateValueAtom(environmentId));
        if (widgetShellObservations.get(environmentId) !== shell) {
          widgetShellObservations.set(environmentId, shell);
          // Coalesce streaming shell updates within a minute. Timer-driven
          // atom recomputations alone cannot confirm an unchanged shell.
          widgetShellConfirmedAt.set(environmentId, Date.now());
        }
        observed.set(environmentId, rows);
      }
      observedWidgetActivities = observed;
      publishReconciledWidget();
      if (
        relayWidgetSnapshot !== null &&
        !sameWidgetEnvironmentScope(previousScope, [...observed.keys()])
      ) {
        runRegistrationInBackground(refreshAgentActivityWidget(), "widget scope refresh failed");
      }
    },
    { immediate: true },
  );
}

// Arm while foregrounded so the token can register; skip nonpublishing environments to avoid a permanently stale seed.
export function armAgentAwarenessLiveActivityForLocalWork(input: {
  readonly environmentId: EnvironmentId;
  readonly threadTitle: string;
  readonly projectTitle: string;
}): void {
  if (!canRegisterRemoteLiveActivities() || !relayTokenProvider) {
    return;
  }
  if (!environmentPublishesAgentActivity(input.environmentId)) {
    return;
  }
  const expectedDeviceGeneration = deviceRegistrationGeneration;
  void loadPreferences()
    .catch(() => null)
    .then((preferences) => {
      if (deviceRegistrationGeneration !== expectedDeviceGeneration || !relayTokenProvider) {
        return;
      }
      if (preferences?.liveActivitiesEnabled === false) {
        runRegistrationInBackground(
          refreshAgentActivityWidget(),
          "widget refresh after local task start failed",
        );
        return;
      }
      armAgentAwarenessLiveActivityForLocalWorkNow(input);
    });
}

function localWorkStartingWidgetProps(input: {
  readonly threadTitle: string;
  readonly projectTitle: string;
}): AgentActivityProps {
  const nowIso = new Date(Date.now()).toISOString();
  return {
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
  };
}

function armAgentAwarenessLiveActivityForLocalWorkNow(input: {
  readonly threadTitle: string;
  readonly projectTitle: string;
}): void {
  try {
    if (getAgentLiveActivities().length > 0) {
      runRegistrationInBackground(
        refreshAgentActivityWidget(),
        "widget refresh after local task start failed",
      );
      return;
    }
    const props = localWorkStartingWidgetProps(input);
    // Only the foreground-only Live Activity needs this optimistic seed.
    // Regular widgets keep observed state until real work arrives.
    const activity = startAgentLiveActivity(props, liveActivityStaleDate());
    if (!activity) {
      return;
    }
    runRegistrationInBackground(
      registerLiveActivityPushToken({ activity }).pipe(
        Effect.ensuring(refreshAgentActivityWidget()),
        Effect.asVoid,
      ),
      "live activity arming after local task start failed",
    );
  } catch (error) {
    logRegistrationError("live activity arming failed", error);
    runRegistrationInBackground(
      refreshAgentActivityWidget(),
      "widget refresh after live activity arming failed",
    );
  }
}

const readAgentActivitySnapshot: (
  excludedEnvironmentIds?: ReadonlyArray<EnvironmentId>,
) => Effect.Effect<
  RelayAgentActivitySnapshotResponse | null,
  never,
  ManagedRelay.ManagedRelayClient
> = Effect.fn("remoteRegistration.readAgentActivitySnapshot")(
  function* (excludedEnvironmentIds?: ReadonlyArray<EnvironmentId>) {
    if (!readRelayConfig()) return null;
    const token = yield* relayToken("read-live-activity-registration-relay-token");
    if (!token) {
      return null;
    }
    const client = yield* ManagedRelay.ManagedRelayClient;
    return yield* client.getAgentActivitySnapshot({ clerkToken: token, excludedEnvironmentIds });
  },
  Effect.catch((error) =>
    Effect.sync(() => {
      logRegistrationError("agent activity snapshot read failed", error);
      return null;
    }),
  ),
);

const refreshAgentActivityWidget = Effect.fn("remoteRegistration.refreshAgentActivityWidget")(
  function* (): Effect.fn.Return<
    RelayAgentActivitySnapshotResponse | null,
    never,
    ManagedRelay.ManagedRelayClient
  > {
    const expectedDeviceGeneration = deviceRegistrationGeneration;
    const expectedRefreshGeneration = ++widgetRefreshGeneration;
    const readStartedWith = observedWidgetActivities;
    const readStartedAt = yield* Clock.currentTimeMillis;
    const snapshot = yield* readAgentActivitySnapshot();
    if (expectedDeviceGeneration !== deviceRegistrationGeneration || !relayTokenProvider) {
      return null;
    }
    // Superseding widget publication does not invalidate this account's priming snapshot.
    if (expectedRefreshGeneration !== widgetRefreshGeneration) return snapshot;
    if (snapshot) {
      observedWidgetActivities = retainUnconfirmedWidgetActivities(
        observedWidgetActivities,
        AppState.currentState === "active" ? liveWidgetActivities : new Map(),
        readStartedWith,
        snapshot,
      );
      let widgetSnapshot = snapshot;
      while (observedWidgetActivities.size > 0) {
        const excludedEnvironmentIds = [...observedWidgetActivities.keys()];
        const scoped = yield* readAgentActivitySnapshot(excludedEnvironmentIds);
        if (expectedDeviceGeneration !== deviceRegistrationGeneration || !relayTokenProvider)
          return null;
        if (expectedRefreshGeneration !== widgetRefreshGeneration) return snapshot;
        if (
          !sameWidgetEnvironmentScope(excludedEnvironmentIds, [...observedWidgetActivities.keys()])
        )
          continue;
        if (scoped) widgetSnapshot = scoped;
        break;
      }
      relayWidgetSnapshot = widgetSnapshot;
      // A response confirms its request's observation time, not the later
      // arrival time. Failed and superseded reads never renew the timeline.
      relayWidgetConfirmedAt = readStartedAt;
      publishReconciledWidget();
    }
    return snapshot;
  },
);

const registerLiveActivityWithRelay = Effect.fn("remoteRegistration.registerLiveActivityWithRelay")(
  function* (
    body: RelayLiveActivityRegistrationRequest,
  ): Effect.fn.Return<boolean, AgentAwarenessRegistrationError, ManagedRelay.ManagedRelayClient> {
    if (!readRelayConfig()) return false;
    const token = yield* relayToken("read-live-activity-registration-relay-token");
    if (!token) {
      return false;
    }

    const client = yield* ManagedRelay.ManagedRelayClient;
    yield* client.registerLiveActivity({
      clerkToken: token,
      payload: body,
    });
    return true;
  },
);

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

function runRegistrationInBackground<E>(
  operation: Effect.Effect<unknown, E, ManagedRelay.ManagedRelayClient>,
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
      // Refresh failures leave the relay's accepted registration intact; preserve registered status.
      if (registrationStatus !== "registered") {
        setRegistrationStatus("failed");
      }
      logRegistrationError(next.context, squashAtomCommandFailure(result));
    }
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
    return;
  }

  pendingDeviceRegistration = pendingDeviceRegistration
    ? {
        input: mergeDeviceRegistrationInput(pendingDeviceRegistration.input, input),
        context,
      }
    : { input, context };
  startPendingDeviceRegistration();
}

const registerDevice = Effect.fn("remoteRegistration.registerDevice")(function* (
  input: RegisterDeviceInput = {},
  expectedGeneration = deviceRegistrationGeneration,
): Effect.fn.Return<void, AgentAwarenessRegistrationError, ManagedRelay.ManagedRelayClient> {
  if (!canRegisterPushNotifications()) {
    return;
  }

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
  if (expectedGeneration !== deviceRegistrationGeneration) return;
  if (relayTokenProvider && relayTokenProviderIdentity) {
    configureAndroidAgentNotifications(
      deviceId,
      relayTokenProviderIdentity,
      preferences.liveActivitiesEnabled !== false,
    );
  }
  const pushTokenRegistration = yield* nativePushTokenRegistration(input?.observedPushToken);
  const bundleId =
    Platform.OS === "android"
      ? Constants.expoConfig?.android?.package?.trim()
      : Constants.expoConfig?.ios?.bundleIdentifier?.trim();
  yield* registerDeviceWithRelay(
    makeRelayDeviceRegistrationRequest({
      deviceId,
      label:
        Constants.deviceName?.trim() ||
        (Platform.OS === "android" ? "Android device" : "iOS device"),
      ...(Platform.OS === "android"
        ? {
            platform: "android" as const,
            androidApiLevel: Number(Platform.Version),
            notificationPermissionGranted: pushTokenRegistration.notificationPermissionGranted,
          }
        : { platform: "ios" as const, iosMajorVersion: iosMajorVersion() }),
      appVersion: Constants.expoConfig?.version,
      ...(bundleId ? { bundleId } : {}),
      ...(Platform.OS === "ios"
        ? { apsEnvironment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant) }
        : {}),
      ...(pushTokenRegistration.pushToken ? { pushToken: pushTokenRegistration.pushToken } : {}),
      notificationsEnabled: pushTokenRegistration.notificationsEnabled,
      preferences,
    }),
    expectedGeneration,
  );
});

function registerDeviceForCurrentUser(): Effect.Effect<
  void,
  AgentAwarenessRegistrationError,
  ManagedRelay.ManagedRelayClient
> {
  return registerDevice(undefined);
}

function ensurePushTokenListener(): void {
  if (pushTokenSubscription || !canRegisterPushNotifications()) {
    return;
  }

  pushTokenSubscription = Notifications.addPushTokenListener((token) => {
    if (
      token.type === Platform.OS &&
      typeof token.data === "string" &&
      token.data.trim().length > 0
    ) {
      enqueueDeviceRegistration(
        { observedPushToken: token.data.trim() },
        "native push token rotation registration failed",
      );
    }
  });
}

function ensureAppStateListener(): void {
  if (appStateSubscription || !canRegisterPushNotifications()) {
    return;
  }

  appStateSubscription = AppState.addEventListener("change", (state) => {
    if (state !== "active") {
      stopLiveWidgetObserver(false);
      publishReconciledWidget();
      return;
    }
    enqueueDeviceRegistration({}, "device registration after app foreground failed");
    startLiveWidgetObserver();
    runRegistrationInBackground(
      refreshActiveLiveActivityRemoteRegistration(),
      "active live activity reconciliation after app foreground failed",
    );
  });
}

// Binaries built before the native dismissEnded method throw here.
function dismissEndedLocalLiveActivities(): void {
  try {
    dismissEndedAgentLiveActivities();
  } catch (error) {
    logRegistrationError("ended live activity cleanup failed", error);
  }
}

function endLocalLiveActivities(context: string): void {
  if (!canRegisterRemoteLiveActivities()) {
    return;
  }
  dismissEndedLocalLiveActivities();
  try {
    for (const activity of getAgentLiveActivities()) {
      activity.end("immediate").catch((error: unknown) => {
        logRegistrationError(context, error);
      });
    }
  } catch (error) {
    logRegistrationError(context, error);
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
): Effect.Effect<void, AgentAwarenessRegistrationError, ManagedRelay.ManagedRelayClient> {
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
  stopLiveWidgetObserver();
  relayWidgetSnapshot = null;
  relayWidgetConfirmedAt = null;
  publishedWidgetContent = null;
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
  widgetRefreshGeneration++;
  activeDeviceRegistration = null;
  pendingDeviceRegistration = null;
  registrationStatus = "unknown";
  androidDeviceReplayedAt = null;
  registrationStatusListeners.clear();
  registeredActivityPushTokens.clear();
  activityPushTokenLocks.clear();
}

export const unregisterAgentAwarenessDeviceForCurrentUser = Effect.fn(
  "remoteRegistration.unregisterAgentAwarenessDeviceForCurrentUser",
)(
  function* (tokenProvider: () => Promise<string | null>) {
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
  },
  Effect.catch((error) =>
    Effect.sync(() => {
      logRegistrationError("device unregistration failed", error);
    }),
  ),
);

export const registerLiveActivityPushToken = Effect.fn(
  "remoteRegistration.registerLiveActivityPushToken",
)(function* (input: {
  readonly activity: LiveActivity<AgentActivityProps>;
}): Effect.fn.Return<boolean, AgentAwarenessRegistrationError, ManagedRelay.ManagedRelayClient> {
  if (!canRegisterRemoteLiveActivities()) {
    return false;
  }

  const lock = observeLiveActivityPushTokens(input.activity);
  return yield* lock.withPermit(
    Effect.gen(function* () {
      const activityPushToken = yield* Effect.tryPromise({
        try: () => input.activity.getPushToken(),
        catch: (cause) =>
          new AgentAwarenessOperationError({
            operation: "read-live-activity-push-token",
            cause,
          }),
      });
      if (!activityPushToken) {
        return false;
      }

      return yield* registerLiveActivityPushTokenValue({ activityPushToken });
    }),
  );
});

// Observe every token replacement: the relay otherwise keeps pushing to the old token until APNs rejects it.
function observeLiveActivityPushTokens(
  activity: LiveActivity<AgentActivityProps>,
): Semaphore.Semaphore {
  const activityId = activity.getId();
  const existing = activityPushTokenLocks.get(activityId);
  if (existing) return existing;
  const lock = Semaphore.makeUnsafe(1);
  activityPushTokenLocks.set(activityId, lock);
  activity.addPushTokenListener((event) => {
    if (!event.pushToken) return;
    runRegistrationInBackground(
      lock.withPermit(registerLiveActivityPushTokenValue({ activityPushToken: event.pushToken })),
      "live activity token listener registration failed",
    );
  });
  return lock;
}

const registerLiveActivityPushTokenValue = Effect.fn(
  "remoteRegistration.registerLiveActivityPushTokenValue",
)(function* (input: {
  readonly activityPushToken: string;
}): Effect.fn.Return<boolean, AgentAwarenessRegistrationError, ManagedRelay.ManagedRelayClient> {
  const acceptedAt = registeredActivityPushTokens.get(input.activityPushToken);
  if (
    acceptedAt !== undefined &&
    (yield* Clock.currentTimeMillis) - acceptedAt < ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS
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
    registeredActivityPushTokens.set(input.activityPushToken, yield* Clock.currentTimeMillis);
  }
  return registered;
});

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

export const refreshActiveLiveActivityRemoteRegistration = Effect.fn(
  "remoteRegistration.refreshActiveLiveActivityRemoteRegistration",
)(function* (): Effect.fn.Return<void, never, ManagedRelay.ManagedRelayClient> {
  if (!canRegisterRemoteLiveActivities() || !relayTokenProvider) {
    return;
  }
  const expectedDeviceGeneration = deviceRegistrationGeneration;

  dismissEndedLocalLiveActivities();
  let activities = yield* Effect.try({
    try: () => getAgentLiveActivities(),
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

  // Read preferences before the snapshot so the widget and a newly primed
  // Live Activity can share one fresh response, including any scoped read.
  const preferences =
    activities.length === 0
      ? yield* Effect.tryPromise({
          try: () => loadPreferences(),
          catch: (cause) =>
            new AgentAwarenessOperationError({
              operation: "load-live-activity-prime-preferences",
              cause,
            }),
        }).pipe(Effect.orElseSucceed(() => null))
      : null;
  if (expectedDeviceGeneration !== deviceRegistrationGeneration || !relayTokenProvider) return;

  // Home-screen widgets update independently of the Live Activity toggle.
  const snapshot = yield* refreshAgentActivityWidget();
  if (expectedDeviceGeneration !== deviceRegistrationGeneration || !relayTokenProvider) return;

  if (
    activities.length === 0 &&
    preferences?.liveActivitiesEnabled !== false &&
    AppState.currentState === "active"
  ) {
    // Local arming may have created a card while preferences or either
    // snapshot request was pending. Register that card instead of a duplicate.
    activities = yield* Effect.try({
      try: () => [...getAgentLiveActivities()],
      catch: () => [] as Array<LiveActivity<AgentActivityProps>>,
    }).pipe(Effect.orElseSucceed(() => [] as Array<LiveActivity<AgentActivityProps>>));
    const aggregate =
      snapshot && "liveActivityAggregate" in snapshot
        ? snapshot.liveActivityAggregate
        : snapshot?.aggregate;
    if (activities.length === 0 && aggregate && aggregate.activeCount > 0) {
      const primed = yield* Effect.try({
        try: () =>
          startAgentLiveActivity(widgetPropsFromAggregate(aggregate), liveActivityStaleDate()),
        catch: (cause) =>
          new AgentAwarenessOperationError({ operation: "prime-live-activity", cause }),
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            logRegistrationError("live activity priming failed", error);
            return null;
          }),
        ),
      );
      if (primed) {
        activities = [primed];
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
