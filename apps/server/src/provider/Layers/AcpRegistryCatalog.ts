import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { AcpRegistryCatalog } from "../acp/AcpRegistrySupport.ts";
import { AcpRegistryRuntimeCoordinator } from "../acp/AcpRegistryRuntimeCoordinator.ts";

/** Server-lifetime ACP Registry catalog shared by setup, snapshots, and turn launch. */
export const AcpRegistryCatalogLive = Layer.merge(
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      return AcpRegistryCatalog.layer({
        cacheDir: config.providerStatusCacheDir,
        toolsDir: path.join(config.baseDir, "tools"),
      });
    }),
  ),
  AcpRegistryRuntimeCoordinator.layer,
);
