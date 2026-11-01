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
    /** Hash user and environment so endpoint keys cannot be claimed by another account. */
    readonly resolveEndpoint: (
      endpointKey: string,
    ) => Effect.Effect<HookEndpoint | null, PersistenceError>;
    readonly setHoldWhileOffline: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly holdWebhooksWhileOffline: boolean;
    }) => Effect.Effect<void, PersistenceError | HookInbox.HookInboxError>;
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

  /** Only links proven by this environment key count; other accounts can claim the same environment id. */
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
