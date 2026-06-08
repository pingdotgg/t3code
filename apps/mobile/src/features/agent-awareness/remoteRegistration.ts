import { addPushToStartTokenListener, type LiveActivity } from "expo-widgets";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import { Platform } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  type RelayDeviceRegistrationRequest,
  type RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import { ManagedRelayClient } from "@t3tools/client-runtime";

import type { SavedRemoteConnection } from "../../lib/connection";
import { mobileRuntime } from "../../lib/runtime";
import {
  loadAgentAwarenessDeviceId,
  loadOrCreateAgentAwarenessDeviceId,
  loadPreferences,
} from "../../lib/storage";
import AgentActivity, { type AgentActivityProps } from "../../widgets/AgentActivity";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { makeRelayDeviceRegistrationRequest } from "./registrationPayload";

const REMOTE_ACTIVITY_REGISTRATION_RETRY_MS = 15_000;
const environmentConnections = new Map<EnvironmentId, SavedRemoteConnection>();
const activityPushTokenListeners = new WeakSet<LiveActivity<AgentActivityProps>>();
let pushToStartSubscription: { remove: () => void } | null = null;
let pushTokenSubscription: { remove: () => void } | null = null;
let activeLiveActivityRegistrationRetry: ReturnType<typeof setTimeout> | null = null;
let relayTokenProvider: (() => Promise<string | null>) | null = null;
let relayTokenProviderIdentity: string | null = null;

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
  relayTokenProvider = provider;
  relayTokenProviderIdentity = provider ? (identity ?? null) : null;
  if (!provider) {
    pushToStartSubscription?.remove();
    pushToStartSubscription = null;
    pushTokenSubscription?.remove();
    pushTokenSubscription = null;
    if (activeLiveActivityRegistrationRetry) {
      clearTimeout(activeLiveActivityRegistrationRetry);
      activeLiveActivityRegistrationRetry = null;
    }
    return;
  }
  ensurePushToStartListener();
  ensurePushTokenListener();
  runRegistrationInBackground(
    refreshActiveLiveActivityRemoteRegistration(),
    "active live activity registration after cloud sign-in failed",
  );
  if (isExistingIdentity) {
    return;
  }
  runRegistrationInBackground(registerDevice(), "device registration after cloud sign-in failed");
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
    if (!canRegisterRemoteLiveActivities()) {
      return { notificationsEnabled: false, pushToken: null };
    }
    if (observedPushToken) {
      return { notificationsEnabled: true, pushToken: observedPushToken };
    }
    const permissions = yield* Effect.tryPromise({
      try: () => Notifications.getPermissionsAsync(),
      catch: (error) => error,
    });
    if (!permissions.granted) {
      return { notificationsEnabled: false, pushToken: null };
    }
    const token = yield* Effect.tryPromise({
      try: () => Notifications.getDevicePushTokenAsync(),
      catch: (error) => error,
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

const relayToken = Effect.gen(function* () {
  const provider = relayTokenProvider;
  if (!provider) {
    return null;
  }
  return yield* Effect.tryPromise({
    try: provider,
    catch: (error) => error,
  });
});

function registerDeviceWithRelay(
  body: RelayDeviceRegistrationRequest,
): Effect.Effect<void, unknown, ManagedRelayClient> {
  return Effect.gen(function* () {
    if (!readRelayConfig()) return;
    const token = yield* relayToken;
    if (!token) {
      logRegistrationDebug("relay device registration skipped; user is not signed in");
      return;
    }

    const client = yield* ManagedRelayClient;
    yield* client.registerDevice({
      clerkToken: token,
      payload: body,
    });
  });
}

function unregisterDeviceWithRelay(input: {
  readonly deviceId: string;
  readonly tokenProvider: () => Promise<string | null>;
}): Effect.Effect<void, unknown, ManagedRelayClient> {
  return Effect.gen(function* () {
    if (!readRelayConfig()) return;
    const token = yield* Effect.tryPromise({
      try: input.tokenProvider,
      catch: (error) => error,
    });
    if (!token) {
      logRegistrationDebug("relay device unregistration skipped; user is not signed in");
      return;
    }

    const client = yield* ManagedRelayClient;
    yield* client.unregisterDevice({
      clerkToken: token,
      deviceId: input.deviceId,
    });
  });
}

function registerLiveActivityWithRelay(
  body: RelayLiveActivityRegistrationRequest,
): Effect.Effect<boolean, unknown, ManagedRelayClient> {
  return Effect.gen(function* () {
    if (!readRelayConfig()) return false;
    const token = yield* relayToken;
    if (!token) {
      logRegistrationDebug("relay live activity registration skipped; user is not signed in");
      return false;
    }

    const client = yield* ManagedRelayClient;
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
  console.warn(
    `[agent-awareness] ${context}`,
    error instanceof Error ? error.message : String(error),
  );
}

function logRegistrationDebug(context: string, details?: unknown): void {
  if (!__DEV__) {
    return;
  }
  console.log(`[agent-awareness] ${context}`, details ?? "");
}

function runRegistrationInBackground(
  operation: Effect.Effect<unknown, unknown, ManagedRelayClient>,
  context: string,
): void {
  void mobileRuntime.runPromise(operation).catch((error: unknown) => {
    logRegistrationError(context, error);
  });
}

function registerDevice(input?: {
  readonly pushToStartToken?: string;
  readonly observedPushToken?: string;
}): Effect.Effect<void, unknown, ManagedRelayClient> {
  return Effect.gen(function* () {
    if (!canRegisterRemoteLiveActivities()) {
      return;
    }

    const [deviceId, preferences] = yield* Effect.all([
      Effect.tryPromise({
        try: () => loadOrCreateAgentAwarenessDeviceId(),
        catch: (error) => error,
      }),
      Effect.tryPromise({
        try: () => loadPreferences(),
        catch: (error) => error,
      }),
    ]);
    const pushTokenRegistration = yield* nativePushTokenRegistration(input?.observedPushToken);
    yield* registerDeviceWithRelay(
      makeRelayDeviceRegistrationRequest({
        deviceId,
        label: Constants.deviceName?.trim() || "iOS device",
        iosMajorVersion: iosMajorVersion(),
        appVersion: Constants.expoConfig?.version,
        ...(pushTokenRegistration.pushToken ? { pushToken: pushTokenRegistration.pushToken } : {}),
        ...(input?.pushToStartToken ? { pushToStartToken: input.pushToStartToken } : {}),
        notificationsEnabled: pushTokenRegistration.notificationsEnabled,
        preferences,
      }),
    );
  });
}

function registerDeviceForCurrentUser(
  pushToStartToken?: string,
): Effect.Effect<void, unknown, ManagedRelayClient> {
  return registerDevice(pushToStartToken ? { pushToStartToken } : undefined);
}

function registerPushToStartTokenForCurrentUser(pushToStartToken: string): void {
  runRegistrationInBackground(
    registerDeviceForCurrentUser(pushToStartToken),
    "push-to-start token registration failed",
  );
}

function ensurePushToStartListener(): void {
  if (pushToStartSubscription || !canRegisterRemoteLiveActivities()) {
    return;
  }

  pushToStartSubscription = addPushToStartTokenListener((event) => {
    const token = event.activityPushToStartToken;
    if (token) {
      registerPushToStartTokenForCurrentUser(token);
    }
  });
}

function ensurePushTokenListener(): void {
  if (pushTokenSubscription || !canRegisterRemoteLiveActivities()) {
    return;
  }

  pushTokenSubscription = Notifications.addPushTokenListener((token) => {
    if (token.type === "ios" && typeof token.data === "string" && token.data.trim().length > 0) {
      runRegistrationInBackground(
        registerDevice({ observedPushToken: token.data.trim() }),
        "native APNs token rotation registration failed",
      );
    }
  });
}

export function registerAgentAwarenessConnection(connection: SavedRemoteConnection): void {
  if (!canRegisterRemoteLiveActivities()) {
    return;
  }

  environmentConnections.set(connection.environmentId, connection);
  ensurePushToStartListener();
  ensurePushTokenListener();
  runRegistrationInBackground(registerDevice(), "device registration failed");
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
  pushToStartSubscription?.remove();
  pushToStartSubscription = null;
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  if (activeLiveActivityRegistrationRetry) {
    clearTimeout(activeLiveActivityRegistrationRetry);
    activeLiveActivityRegistrationRetry = null;
  }
}

export function refreshAgentAwarenessRegistration(): Effect.Effect<
  void,
  never,
  ManagedRelayClient
> {
  return registerDeviceForCurrentUser().pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logRegistrationError("device registration refresh failed", error);
      }),
    ),
  );
}

export function __resetAgentAwarenessRemoteRegistrationForTest(): void {
  environmentConnections.clear();
  pushToStartSubscription?.remove();
  pushToStartSubscription = null;
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  if (activeLiveActivityRegistrationRetry) {
    clearTimeout(activeLiveActivityRegistrationRetry);
    activeLiveActivityRegistrationRetry = null;
  }
  relayTokenProvider = null;
  relayTokenProviderIdentity = null;
}

export function unregisterAgentAwarenessDeviceForCurrentUser(
  tokenProvider: () => Promise<string | null>,
): Effect.Effect<void, never, ManagedRelayClient> {
  return Effect.gen(function* () {
    const deviceId = yield* Effect.tryPromise({
      try: () => loadAgentAwarenessDeviceId(),
      catch: (error) => error,
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
}): Effect.Effect<boolean, unknown, ManagedRelayClient> {
  return Effect.gen(function* () {
    if (!canRegisterRemoteLiveActivities()) {
      return false;
    }

    const activityPushToken = yield* Effect.tryPromise({
      try: () => input.activity.getPushToken(),
      catch: (error) => error,
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
}): Effect.Effect<boolean, unknown, ManagedRelayClient> {
  return Effect.gen(function* () {
    const deviceId = yield* Effect.tryPromise({
      try: () => loadOrCreateAgentAwarenessDeviceId(),
      catch: (error) => error,
    });
    const registered = yield* registerLiveActivityWithRelay({
      deviceId,
      activityPushToken: input.activityPushToken,
    });
    if (registered) {
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
  ManagedRelayClient
> {
  return Effect.gen(function* () {
    if (!canRegisterRemoteLiveActivities() || !relayTokenProvider) {
      return;
    }

    const activities = yield* Effect.try({
      try: () => AgentActivity.getInstances(),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          logRegistrationError("active live activity lookup failed", error);
          return [] as ReadonlyArray<LiveActivity<AgentActivityProps>>;
        }),
      ),
    );

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
