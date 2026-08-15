import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { AcpRegistryCatalog } from "../acp/AcpRegistrySupport.ts";
import { AcpRegistryRuntimeCoordinator } from "../acp/AcpRegistryRuntimeCoordinator.ts";

/** Server-lifetime ACP Registry catalog shared by setup, snapshots, and turn launch. */
export const AcpRegistryCatalogLive = Layer.merge(
  Layer.unwrap(
    Effect.map(ServerConfig, (config) =>
      AcpRegistryCatalog.layer({ cacheDir: config.providerStatusCacheDir }),
    ),
  ),
  AcpRegistryRuntimeCoordinator.layer,
);
