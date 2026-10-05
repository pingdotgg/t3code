import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as RelayConfiguration from "../Config.ts";
import {
  MANAGED_ENDPOINT_KEY_PATTERN,
  managedEndpointTunnelNameForKey,
} from "../deploymentConfig.ts";
import { validateManagedEndpoint } from "../environments/EnvironmentConnector.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as HookInbox from "./HookInbox.ts";

/** The endpoint key of an environment's own managed endpoint, for authenticated callers. */
export const endpointKeyForTunnelName = (namespace: string, tunnelName: string): string | null => {
  const prefix = managedEndpointTunnelNameForKey(namespace, "");
  const key = tunnelName.startsWith(prefix) ? tunnelName.slice(prefix.length) : "";
  return MANAGED_ENDPOINT_KEY_PATTERN.test(key) ? key : null;
};

type PersistenceError =
  | EnvironmentLinks.EnvironmentLinkEnvironmentLookupPersistenceError
  | ManagedEndpointAllocations.ManagedEndpointAllocationPersistenceError;

interface HookEndpoint {
  readonly httpBaseUrl: string;
  readonly environmentId: string;
  readonly holdWhileOffline: boolean;
}

export class HeldHooks extends Context.Service<
  HeldHooks,
  {
    /**
     * The ready managed endpoint a webhook URL's endpoint key names, with whether
     * its link opted in to holding webhooks while offline. The key is the tunnel
     * name's hash of user and environment, so it names exactly one allocation and
     * at most one active link; nobody else can link their way onto it.
     */
    readonly resolveEndpoint: (
      endpointKey: string,
    ) => Effect.Effect<HookEndpoint | null, PersistenceError>;
    /**
     * Saves an environment's opt-in. Opting out also drops what is already held,
     * rather than delivering it later to an environment that said it does not
     * want it. Only the links the caller's environment key proved are touched.
     */
    readonly setHoldWhileOffline: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly holdWebhooksWhileOffline: boolean;
    }) => Effect.Effect<void, PersistenceError | HookInbox.HookInboxError>;
    /** Delivers what the environment's endpoints hold now; true when anything was waiting. */
    readonly wake: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<boolean, PersistenceError | HookInbox.HookInboxError>;
  }
>()("t3code-relay/hooks/HeldHooks") {}

const make = Effect.gen(function* () {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
  const settings = yield* RelayConfiguration.RelayConfiguration;
  const inbox = yield* HookInbox.HookInbox;

  const resolveEndpoint: HeldHooks["Service"]["resolveEndpoint"] = Effect.fn(
    "relay.hooks.resolve_endpoint",
  )(function* (endpointKey) {
    if (!settings.managedEndpointNamespace) return null;
    const allocation = yield* allocations.getByTunnelName(
      managedEndpointTunnelNameForKey(settings.managedEndpointNamespace, endpointKey),
    );
    if (allocation === null) return null;
    const [link] = yield* links.findActiveManagedForEnvironment({
      environmentId: allocation.environmentId,
      userId: allocation.userId,
    });
    if (!link) return null;
    const result = validateManagedEndpoint({
      link,
      allocation,
      baseDomain: settings.managedEndpointBaseDomain,
    });
    if (Result.isFailure(result)) return null;
    return {
      ...result.success,
      environmentId: allocation.environmentId,
      holdWhileOffline: link.holdWebhooksWhileOffline,
    };
  });

  /**
   * Endpoint keys of the managed links the calling environment key proved.
   * The environment id alone would also match other accounts' links of it.
   */
  const ownEndpointKeys = Effect.fn("relay.hooks.own_endpoint_keys")(function* (input: {
    readonly environmentId: string;
    readonly environmentPublicKey: string;
  }) {
    const namespace = settings.managedEndpointNamespace;
    if (!namespace) return [];
    const ownLinks = yield* links.findActiveManagedForEnvironment(input);
    const keys: Array<string> = [];
    for (const link of ownLinks) {
      const allocation = yield* allocations.get({
        userId: link.userId,
        environmentId: input.environmentId,
      });
      const key = allocation ? endpointKeyForTunnelName(namespace, allocation.tunnelName) : null;
      if (key !== null) keys.push(key);
    }
    return keys;
  });

  const setHoldWhileOffline: HeldHooks["Service"]["setHoldWhileOffline"] = Effect.fn(
    "relay.hooks.set_hold_while_offline",
  )(function* (input) {
    yield* links.setHoldWebhooksWhileOffline(input);
    if (input.holdWebhooksWhileOffline) return;
    for (const endpointKey of yield* ownEndpointKeys(input)) {
      yield* inbox.clear({ endpointKey });
    }
  });

  const wake: HeldHooks["Service"]["wake"] = Effect.fn("relay.hooks.wake")(function* (input) {
    let pending = false;
    for (const endpointKey of yield* ownEndpointKeys(input)) {
      const endpoint = yield* resolveEndpoint(endpointKey);
      if (endpoint === null) continue;
      if (yield* inbox.wake({ endpointKey, baseUrl: endpoint.httpBaseUrl })) {
        pending = true;
      }
    }
    return pending;
  });

  return HeldHooks.of({ resolveEndpoint, setHoldWhileOffline, wake });
});

export const layer = Layer.effect(HeldHooks, make);
