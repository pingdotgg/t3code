import { msg } from "gt-react-native";
import { m } from "../../i18n/messages";
import type {
  DirectPushDelivery,
  DirectPushRegistration,
  DirectPushStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import { requestDirectPush } from "@t3tools/client-runtime/rpc";
import {
  createRuntimeCommand,
  runAtomCommand,
  runInEnvironment,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import Constants from "expo-constants";
import * as Application from "expo-application";
import * as Notifications from "expo-notifications";
import type { LiveActivity, LiveActivityFactory } from "expo-widgets";
import { AppState } from "react-native";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import { relativeTime } from "../../lib/time";
import type { AgentActivityProps } from "../../widgets/AgentActivity";

const command = createRuntimeCommand(connectionAtomRuntime, {
  label: "direct-push",
  concurrency: { mode: "serial", key: (input) => input.environmentId },
  execute: (input: {
    environmentId: EnvironmentId;
    request: Parameters<typeof requestDirectPush>[0];
  }) => runInEnvironment(input.environmentId, requestDirectPush(input.request)),
});
async function request(
  environmentId: EnvironmentId,
  input: Parameters<typeof requestDirectPush>[0],
) {
  const result = await runAtomCommand(appAtomRegistry, command, { environmentId, request: input });
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  return result.value;
}

const factories = new Map<EnvironmentId, LiveActivityFactory<AgentActivityProps>>();
const listeners = new Map<EnvironmentId, { id: string; remove: () => void }>();
const registrations = new Map<EnvironmentId, DirectPushRegistration>();
const pending = new Map<EnvironmentId, Promise<DirectPushStatus | null>>();
let devicePushToken: string | null = null;
export function rememberDirectPushToken(token: Notifications.DevicePushToken): boolean {
  if (typeof token.data !== "string" || devicePushToken === token.data) return false;
  devicePushToken = token.data;
  return true;
}
async function readDevicePushToken() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Notifications.getDevicePushTokenAsync(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Still waiting for Apple's device token. Check connectivity and reopen the app to retry.",
              ),
            ),
          15_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function factory(environmentId: EnvironmentId) {
  const existing = factories.get(environmentId);
  if (existing) return existing;
  const [{ createLiveActivity }, { AgentActivity }] = await Promise.all([
    import("expo-widgets"),
    import("../../widgets/AgentActivity"),
  ]);
  const created = createLiveActivity(`DirectAgentActivity:${environmentId}`, AgentActivity);
  factories.set(environmentId, created);
  return created;
}

async function attachToken(
  environmentId: EnvironmentId,
  activity: LiveActivity<AgentActivityProps>,
) {
  const id = activity.getId();
  if (listeners.get(environmentId)?.id !== id) {
    listeners.get(environmentId)?.remove();
    const listener = activity.addPushTokenListener(({ pushToken }) => {
      const previous = registrations.get(environmentId);
      if (!previous) return;
      const registration = { ...previous, activityToken: pushToken };
      registrations.set(environmentId, registration);
      void request(environmentId, { action: "register", registration }).catch(() => {
        console.warn("Could not register the Live Activity token. Reopen the app to retry.");
      });
    });
    listeners.set(environmentId, { id, remove: () => listener.remove() });
  }
  return activity.getPushToken();
}

export function syncDirectPush(
  environmentId: EnvironmentId,
  liveActivitiesEnabled: boolean,
): Promise<DirectPushStatus | null> {
  const existing = pending.get(environmentId);
  if (existing) return existing.then(() => syncDirectPush(environmentId, liveActivitiesEnabled));
  const operation = (async () => {
    const status = await request(environmentId, { action: "status" });
    if (!status?.configured) return status;
    const bundleId = Application.applicationId ?? Constants.expoConfig?.ios?.bundleIdentifier;
    if (bundleId !== status.bundleId)
      throw new Error("The server's APNs bundle ID does not match this app.");
    let apsEnvironment = await Application.getIosPushNotificationServiceEnvironmentAsync();
    if (!apsEnvironment) {
      // Expo reads embedded.mobileprovision, which Apple-distributed installs can omit.
      // Its native release-type API recognizes those device installs as App Store builds.
      const releaseType = await Application.getIosApplicationReleaseTypeAsync();
      if (releaseType === Application.ApplicationReleaseType.APP_STORE) {
        apsEnvironment = "production";
      } else {
        throw new Error(
          releaseType === Application.ApplicationReleaseType.SIMULATOR
            ? "Apple push registration requires a physical iPhone or iPad."
            : "Could not determine this build's Apple push environment. Check its push provisioning profile.",
        );
      }
    }
    const permission = await Notifications.getPermissionsAsync();
    if (!devicePushToken) rememberDirectPushToken(await readDevicePushToken());
    const pushToken = devicePushToken;
    const registration: DirectPushRegistration = {
      deviceId: await loadOrCreateAgentAwarenessDeviceId(),
      bundleId,
      apsEnvironment: apsEnvironment === "development" ? "sandbox" : "production",
      pushToken: typeof pushToken === "string" ? pushToken : null,
      activityToken: null,
      notificationsEnabled: permission.granted,
      liveActivitiesEnabled,
    };
    registrations.set(environmentId, registration);
    let activityFailed = false;
    try {
      const activityFactory = await factory(environmentId);
      const instances = activityFactory.getInstances();
      let activity: LiveActivity<AgentActivityProps> | undefined = instances[0];
      for (const duplicate of instances.slice(1)) await duplicate.end("immediate");
      if (!liveActivitiesEnabled || status.activity.activeCount === 0) {
        if (activity) await activity.end("immediate");
        activity = undefined;
        listeners.get(environmentId)?.remove();
        listeners.delete(environmentId);
      } else if (!activity && AppState.currentState === "active") {
        activity = activityFactory.start(
          status.activity,
          undefined,
          new Date(Date.now() + 600_000),
        );
      }
      if (activity) {
        const token = await attachToken(environmentId, activity);
        if (token) registrations.set(environmentId, { ...registration, activityToken: token });
        await activity.update(status.activity, new Date(Date.now() + 600_000));
      }
    } catch {
      activityFailed = true;
    }
    const registered = await request(environmentId, {
      action: "register",
      registration: registrations.get(environmentId)!,
    });
    if (activityFailed)
      throw new Error(
        "Notifications registered. Live Activities are unavailable; check this app's Live Activities setting in iOS.",
      );
    return registered;
  })().finally(() => pending.delete(environmentId));
  pending.set(environmentId, operation);
  return operation;
}

export async function disableDirectPush(environmentId: EnvironmentId) {
  await pending.get(environmentId)?.catch(() => undefined);
  listeners.get(environmentId)?.remove();
  listeners.delete(environmentId);
  registrations.delete(environmentId);
  try {
    const activityFactory = factories.get(environmentId) ?? (await factory(environmentId));
    await Promise.all(activityFactory.getInstances().map((activity) => activity.end("immediate")));
  } finally {
    await request(environmentId, { action: "unregister" });
  }
}

/** Apple's answer to the server's latest send, the one thing that tells a bad token from a quiet agent. */
export function describeDirectPushDelivery(delivery: DirectPushDelivery): string {
  if (delivery.status === 200)
    return m(msg("Last push: delivered {value} ago", { value: relativeTime(delivery.at) }));
  if (delivery.status === null)
    return m(
      msg("Last push: no answer from Apple{value}", {
        value: delivery.reason ? ` (${delivery.reason})` : "",
      }),
    );
  return m(
    msg("Last push: rejected by Apple ({value})", {
      value: delivery.reason ?? `HTTP ${delivery.status}`,
    }),
  );
}
