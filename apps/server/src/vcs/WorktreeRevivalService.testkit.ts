import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as WorktreeRevivalService from "./WorktreeRevivalService.ts";

export const layerNoop = Layer.succeed(
  WorktreeRevivalService.WorktreeRevivalService,
  WorktreeRevivalService.WorktreeRevivalService.of({
    reviveForThread: () => Effect.succeed({ revived: false, generation: 0 }),
  }),
);
