import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  MANAGED_ENDPOINT_ZONE_OWNER_STAGE,
  relayOwnsManagedEndpointZone,
  relayPublicDomainForStage,
} from "./deploymentConfig.ts";

function withLogicalId<Resource extends object>(resource: Resource, logicalId: string): Resource {
  return new Proxy(resource, {
    has: (target, property) => property === "LogicalId" || property in target,
    get: (target, property, receiver) =>
      property === "LogicalId" ? logicalId : Reflect.get(target, property, receiver),
  });
}

export const RelayDeploymentConfig = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const relayApiZoneName = yield* Config.nonEmptyString("RELAY_API_ZONE_NAME");
  const managedEndpointZoneName = yield* Config.nonEmptyString("RELAY_TUNNEL_ZONE_NAME");
  const relayPublicDomainOverride = yield* Config.string("RELAY_DOMAIN").pipe(
    Config.option,
    Config.map(
      Option.flatMap((value) => {
        const trimmed = value.trim();
        return trimmed ? Option.some(trimmed) : Option.none();
      }),
    ),
  );
  const relayPublicDomain = Option.getOrElse(relayPublicDomainOverride, () =>
    relayPublicDomainForStage(stage, relayApiZoneName),
  );

  return {
    stage,
    relayPublicDomain,
    relayPublicOrigin: `https://${relayPublicDomain}`,
    relayApiZoneName,
    managedEndpointZoneName,
  };
});

export const ManagedEndpointZone = RelayDeploymentConfig.pipe(
  Effect.flatMap(({ stage, managedEndpointZoneName }) =>
    relayOwnsManagedEndpointZone(stage)
      ? Cloudflare.Zone("ManagedEndpointZone", { name: managedEndpointZoneName }).pipe(adopt(true))
      : Cloudflare.Zone.ref("ManagedEndpointZone", {
          stage: MANAGED_ENDPOINT_ZONE_OWNER_STAGE,
        }).pipe(
          // Alchemy beta's DNS binding policy uses LogicalId to derive a
          // stable SID, but Resource.ref returns a lazy output proxy.
          Effect.map((zone) => withLogicalId(zone, "ManagedEndpointZone")),
        ),
  ),
);

export const RelayApiZone = RelayDeploymentConfig.pipe(
  Effect.flatMap(({ stage, relayApiZoneName, managedEndpointZoneName }) =>
    relayApiZoneName === managedEndpointZoneName
      ? ManagedEndpointZone
      : relayOwnsManagedEndpointZone(stage)
        ? Cloudflare.Zone("RelayApiZone", { name: relayApiZoneName }).pipe(adopt(true))
        : Cloudflare.Zone.ref("RelayApiZone", {
            stage: MANAGED_ENDPOINT_ZONE_OWNER_STAGE,
          }),
  ),
);
