import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as AcpRegistrySupport from "../acp/AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "../acp/AcpRegistryRuntimeCoordinator.ts";

/** Server-lifetime ACP Registry catalog shared by setup, snapshots, and turn launch. */
export const layer = Layer.merge(
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      return AcpRegistrySupport.AcpRegistryCatalog.layer({
        cacheDir: config.providerStatusCacheDir,
        toolsDir: path.join(config.baseDir, "tools"),
      });
    }),
  ),
  AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator.layer,
);
