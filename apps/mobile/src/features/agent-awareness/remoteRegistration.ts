import { addPushToStartTokenListener, type LiveActivity } from "expo-widgets";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Platform } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  type RelayDeviceRegistrationRequest,
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
import {
  loadAgentAwarenessDeviceId,
  loadOrCreateAgentAwarenessDeviceId,
  loadPreferences,
} from "../../lib/storage";
import AgentActivity, { type AgentActivityProps } from "../../widgets/AgentActivity";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { isNotificationPermissionGranted } from "./notificationPermissions";
import { makeRelayDeviceRegistrationRequest } from "./registrationPayload";

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
let pushToStartSubscription: { remove: () => void } | null = null;
let pushTokenSubscription: { remove: () => void } | null = null;
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
  readonly pushToStartToken?: string;
  readonly observedPushToken?: string;
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
  }
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
  enqueueDeviceRegistration({}, "device registration after cloud sign-in failed");
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
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-notification-permissions",
          cause,
        }),
    });
    if (!isNotificationPermissionGranted(permissions)) {
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
    if (!readRelayConfig()) return;
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
      return;
    }

    const client = yield* ManagedRelay.ManagedRelayClient;
    logRegistrationDebug("relay device registration request started", {
      expectedGeneration,
    });
    yield* client.registerDevice({
      clerkToken: token,
      payload: body,
    });
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
  return {
    ...((next.pushToStartToken ?? current.pushToStartToken)
      ? { pushToStartToken: next.pushToStartToken ?? current.pushToStartToken }
      : {}),
    ...((next.observedPushToken ?? current.observedPushToken)
      ? { observedPushToken: next.observedPushToken ?? current.observedPushToken }
      : {}),
  };
}

function registrationAddsInformation(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): boolean {
  return (
    (next.pushToStartToken !== undefined && next.pushToStartToken !== current.pushToStartToken) ||
    (next.observedPushToken !== undefined && next.observedPushToken !== current.observedPushToken)
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
    hasPushToStartToken: next.input.pushToStartToken !== undefined,
  });
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
  input: DeviceRegistrationInput = {},
  expectedGeneration = deviceRegistrationGeneration,
): Effect.Effect<void, unknown, ManagedRelay.ManagedRelayClient> {
  return Effect.gen(function* () {
    if (!canRegisterRemoteLiveActivities()) {
      logRegistrationDebug("device registration skipped; platform does not support it");
      return;
    }

    logRegistrationDebug("device registration loading local state", { expectedGeneration });
    const [deviceId, preferences] = yield* Effect.all([
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
    const pushTokenRegistration = yield* nativePushTokenRegistration(input?.observedPushToken);
    logRegistrationDebug("device registration local state ready", {
      expectedGeneration,
      notificationsEnabled: pushTokenRegistration.notificationsEnabled,
    });
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
      expectedGeneration,
    );
  });
}

function registerDeviceForCurrentUser(
  pushToStartToken?: string,
): Effect.Effect<void, unknown, ManagedRelay.ManagedRelayClient> {
  return registerDevice(pushToStartToken ? { pushToStartToken } : undefined);
}

function registerPushToStartTokenForCurrentUser(pushToStartToken: string): void {
  enqueueDeviceRegistration({ pushToStartToken }, "push-to-start token registration failed");
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
      enqueueDeviceRegistration(
        { observedPushToken: token.data.trim() },
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
  ManagedRelay.ManagedRelayClient
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
  deviceRegistrationGeneration++;
  activeDeviceRegistration = null;
  pendingDeviceRegistration = null;
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

    const activities = yield* Effect.try({
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
