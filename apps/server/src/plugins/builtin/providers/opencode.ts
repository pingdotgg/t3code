import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../config.ts";

/** Runtime and ledger share the server's existing state directory and Effect layer graph. */
export const layerRuntime = OpenCodeRuntime.layer.pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        return OpenCodeServerLedger.layer({ stateDir: config.stateDir });
      }),
    ),
  ),
);
