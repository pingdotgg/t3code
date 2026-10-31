import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as TurnItemContentStore from "./TurnItemContentStore.ts";

export const layerPassthrough = Layer.succeed(
  TurnItemContentStore.TurnItemContentStore,
  TurnItemContentStore.TurnItemContentStore.of({
    store: (item) => Effect.succeed(item),
    read: (item) => Effect.succeed(item),
  }),
);
