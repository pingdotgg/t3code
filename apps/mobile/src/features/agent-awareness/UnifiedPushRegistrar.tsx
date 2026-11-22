import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type UnifiedPushRegistration, WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  environmentSessionGenerationAtom,
  settleAsyncResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { savedConnectionsByIdAtom } from "../../state/use-remote-environment-registry";
import { getUnifiedPushState, isUnifiedPushBuild, subscribeUnifiedPushState } from "./unifiedPush";
import { unifiedPushRegistration } from "./unifiedPush.logic";

const registerUnifiedPush = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "unifiedPushRegister",
  tag: WS_METHODS.unifiedPushRegister,
});

const unregisterUnifiedPush = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "unifiedPushUnregister",
  tag: WS_METHODS.unifiedPushUnregister,
});

/** Keeps every paired server told where to push this phone's agent notifications. */
export function UnifiedPushRegistrar() {
  if (!isUnifiedPushBuild()) return null;
  return <ConfiguredUnifiedPushRegistrar />;
}

function ConfiguredUnifiedPushRegistrar() {
  const state = useSyncExternalStore(subscribeUnifiedPushState, getUnifiedPushState, () => null);
  const connections = useAtomValue(savedConnectionsByIdAtom);
  const registration = unifiedPushRegistration(state);
  if (!registration) return null;
  return (Object.keys(connections) as EnvironmentId[]).map((environmentId) => (
    <EnvironmentRegistration
      key={environmentId}
      environmentId={environmentId}
      registration={registration}
    />
  ));
}

function EnvironmentRegistration(props: {
  readonly environmentId: EnvironmentId;
  readonly registration: UnifiedPushRegistration;
}) {
  const session = useAtomValue(
    environmentSessionGenerationAtom(connectionAtomRuntime, props.environmentId),
  );
  const { environmentId } = props;
  const { deviceId, endpoint, keys } = props.registration;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the server, on each new session, where to push; servers keep registrations across restarts, but a new endpoint or a re-paired server needs it again
  useEffect(() => {
    if (session === 0) return;
    void settleAsyncResult(() =>
      runtime.runPromiseExit(
        registerUnifiedPush.run(appAtomRegistry, {
          environmentId,
          input: { deviceId, endpoint, ...(p256dh && auth ? { keys: { p256dh, auth } } : {}) },
        }),
      ),
    ).then((result) => {
      // Best effort: an official server has no such method, and a failure retries next session.
      if (result._tag === "Failure" && __DEV__) {
        console.warn("[unifiedpush] register failed", { environmentId });
      }
    });
  }, [environmentId, session, deviceId, endpoint, p256dh, auth]);
  return null;
}

/** Asks every connected server to stop pushing to this phone. */
export const unregisterUnifiedPushEverywhere = (deviceId: string) =>
  Effect.forEach(
    Object.keys(appAtomRegistry.get(savedConnectionsByIdAtom)) as EnvironmentId[],
    (environmentId) =>
      unregisterUnifiedPush
        .run(appAtomRegistry, { environmentId, input: { deviceId } })
        .pipe(Effect.ignore),
    { concurrency: "unbounded", discard: true },
  );
