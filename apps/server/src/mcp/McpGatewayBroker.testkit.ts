import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type TailnetDeviceAccess } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Membership from "../peer/Membership.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";

export { DESKTOP_APP_SUBJECT } from "../auth/PairingGrantStore.ts";

/** A session paired to this server by code, with no identity in the network. */
export const CODE_PAIRED_SUBJECT = "one-time-token";

/**
 * What the broker reads: this server's roster and the switch. The roster is empty unless a test
 * writes it, or `self` seeds this machine's own entry.
 */
export const layerDependencies = (
  options: {
    readonly environmentId?: EnvironmentId;
    readonly linksOff?: boolean;
    readonly self?: TailnetDeviceAccess;
  } = {},
) => {
  const environmentId = options.environmentId ?? EnvironmentId.make("here");
  const self = options.self;
  const base = Membership.layer.pipe(
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provideMerge(
      ServerSettings.layerTest({ linkedEnvironmentsEnabled: options.linksOff !== true }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  if (self === undefined) return base;
  const seed = Membership.Membership.pipe(
    Effect.flatMap((membership) =>
      membership.put({ environmentId, label: environmentId, nodeId: null, access: self }),
    ),
    Effect.orDie,
  );
  return Layer.effectDiscard(seed).pipe(Layer.provideMerge(base));
};
