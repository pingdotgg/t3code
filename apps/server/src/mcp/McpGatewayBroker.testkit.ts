import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Membership from "../peer/Membership.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";

/** A session paired to this server by code, with no identity in the network. */
export const CODE_PAIRED_SUBJECT = "one-time-token";

/** What the broker reads: this server's roster (empty unless a test writes it) and the switch. */
export const layerDependencies = (
  options: { readonly environmentId?: EnvironmentId; readonly linksOff?: boolean } = {},
) =>
  Membership.layer.pipe(
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(options.environmentId ?? EnvironmentId.make("here")),
      }),
    ),
    Layer.provideMerge(
      ServerSettings.layerTest({ linkedEnvironmentsEnabled: options.linksOff !== true }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
