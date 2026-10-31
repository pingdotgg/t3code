import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as TurnItemContentStore from "./TurnItemContentStore.ts";

export const layerPassthrough = Layer.succeed(
  TurnItemContentStore.TurnItemContentStore,
  TurnItemContentStore.TurnItemContentStore.of({
    store: (item) => Effect.succeed(item),
    storeForCommit: (item) => Effect.succeed({ item, createdAttachmentIds: [] }),
    removeNewAttachments: () => Effect.void,
    read: (item) => Effect.succeed(item),
  }),
);
