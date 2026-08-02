import {
  type ProviderAuthAttachStreamEvent,
  type ProviderAuthSessionSnapshot,
  type ServerProvider,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

const MAX_HISTORY_LENGTH = 262_144;

export function selectProviderAuthSetupCandidates(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.filter(
    (provider) =>
      provider.installed &&
      provider.enabled &&
      provider.auth.status === "unauthenticated" &&
      provider.authManagement?.canSignIn,
  );
}

export function applyProviderAuthAttachEvent(
  current: ProviderAuthSessionSnapshot | null,
  event: ProviderAuthAttachStreamEvent,
): ProviderAuthSessionSnapshot | null {
  if (event.type === "snapshot" || event.type === "settled") return event.snapshot;
  if (
    current === null ||
    event.sessionId !== current.sessionId ||
    event.sequence <= current.sequence
  ) {
    return current;
  }
  return {
    ...current,
    history: `${current.history}${event.data}`.slice(-MAX_HISTORY_LENGTH),
    sequence: event.sequence,
  };
}

export function createProviderAuthEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const sessionKey = ({ environmentId, input }: { environmentId: string; input: object }) =>
    JSON.stringify([environmentId, "sessionId" in input ? input.sessionId : input]);

  return {
    attach: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:provider-auth:attach",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.providerAuthAttach>) =>
        subscribe(WS_METHODS.providerAuthAttach, input).pipe(
          Stream.scan(null as ProviderAuthSessionSnapshot | null, applyProviderAuthAttachEvent),
        ),
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-auth:start",
      tag: WS_METHODS.providerAuthStart,
      scheduler: lifecycleScheduler,
      concurrency: { mode: "singleFlight", key: sessionKey },
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-auth:write",
      tag: WS_METHODS.providerAuthWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-auth:resize",
      tag: WS_METHODS.providerAuthResize,
      concurrency: { mode: "latest", key: sessionKey },
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-auth:cancel",
      tag: WS_METHODS.providerAuthCancel,
      scheduler: lifecycleScheduler,
      concurrency: { mode: "singleFlight", key: sessionKey },
    }),
  };
}
