import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AtomRegistry } from "effect/reactivity";

import type { SavedRemoteConnection } from "../../lib/connection";
import { appAtomRuntime } from "../../lib/runtime";
import { saveMobilePreferencesEffect } from "../../state/preferences";
import { setLiveActivityUpdatesEnabled } from "./liveActivityPreferences";
import { requestAgentNotificationPermission } from "./notificationPermissions";
import { refreshAgentAwarenessRegistration } from "./remoteRegistration";

export class LiveActivityRelayTokenError extends Schema.TaggedError<LiveActivityRelayTokenError>()(
  "LiveActivityRelayTokenError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not read the relay session token.";
  }
}

interface LiveActivityUpdatesInput {
  /** Null when no account is signed in. */
  readonly getClerkToken: (() => Promise<string | null>) | null;
  readonly previousEnabled: boolean;
  readonly connections: ReadonlyArray<SavedRemoteConnection>;
  readonly canConfigureEnvironment: (environmentId: EnvironmentId) => boolean;
}

const setLiveActivityUpdates = Effect.fn("agentAwareness.setLiveActivityUpdates")(function* (
  enabled: boolean,
  input: LiveActivityUpdatesInput,
  registry: AtomRegistry.AtomRegistry,
) {
  const getClerkToken = input.getClerkToken;
  const clerkToken =
    getClerkToken === null
      ? null
      : yield* Effect.tryPromise({
          try: () => getClerkToken(),
          catch: (cause) => new LiveActivityRelayTokenError({ cause }),
        });
  if (enabled && !clerkToken) return "signed-out" as const;

  yield* setLiveActivityUpdatesEnabled({
    enabled,
    previousEnabled: input.previousEnabled,
    clerkToken,
    connections: input.connections,
    canConfigureEnvironment: input.canConfigureEnvironment,
    saveLocalPreference: (liveActivitiesEnabled) =>
      saveMobilePreferencesEffect({ liveActivitiesEnabled }, registry),
  });
  return "saved" as const;
});

export const enableLiveActivityUpdates = createRuntimeCommand(appAtomRuntime, {
  label: "mobile:agent-awareness:enable-live-activity-updates",
  execute: (input: LiveActivityUpdatesInput, registry) =>
    setLiveActivityUpdates(true, input, registry),
});

export const disableLiveActivityUpdates = createRuntimeCommand(appAtomRuntime, {
  label: "mobile:agent-awareness:disable-live-activity-updates",
  execute: (input: LiveActivityUpdatesInput, registry) =>
    setLiveActivityUpdates(false, input, registry),
});

export const requestAgentNotifications = createRuntimeCommand(appAtomRuntime, {
  label: "mobile:agent-awareness:request-notifications",
  execute: (input: { readonly registerDevice: boolean }) =>
    requestAgentNotificationPermission.pipe(
      Effect.tap((permission) =>
        input.registerDevice && permission.type === "granted"
          ? refreshAgentAwarenessRegistration()
          : Effect.void,
      ),
    ),
});
