// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type { ExtensionCatalogueChange } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

/** Metadata-only invalidation; consumers refresh the authoritative catalogue. */
export class ExtensionCatalogueChanges extends Context.Service<
  ExtensionCatalogueChanges,
  {
    readonly publish: Effect.Effect<void>;
    readonly changes: Stream.Stream<ExtensionCatalogueChange>;
  }
>()("t3/extensions/catalogueChanges/ExtensionCatalogueChanges") {}

export const make = Effect.gen(function* () {
  const events = yield* Effect.acquireRelease(
    PubSub.sliding<ExtensionCatalogueChange>({ capacity: 1, replay: 1 }),
    PubSub.shutdown,
  );
  let current: ExtensionCatalogueChange = { epoch: NodeCrypto.randomUUID(), revision: 0 };
  yield* PubSub.publish(events, current);
  const publish = Effect.suspend(() => {
    current =
      current.revision === Number.MAX_SAFE_INTEGER
        ? { epoch: NodeCrypto.randomUUID(), revision: 0 }
        : { epoch: current.epoch, revision: current.revision + 1 };
    return PubSub.publish(events, current).pipe(Effect.asVoid);
  });
  return ExtensionCatalogueChanges.of({
    publish,
    changes: Stream.fromPubSub(events),
  });
});

export const layer = Layer.effect(ExtensionCatalogueChanges, make);
