import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { WorktreeRevivalService } from "./WorktreeRevivalService.ts";

export const layerNoop = Layer.succeed(
  WorktreeRevivalService,
  WorktreeRevivalService.of({
    reviveWorktree: () => Effect.succeed({ revived: false }),
    reviveForThread: () => Effect.succeed({ revived: false, generation: 0 }),
  }),
);
