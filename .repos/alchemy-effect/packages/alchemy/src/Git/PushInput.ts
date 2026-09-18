/** Construct a streaming push from an application's own protocol or background job. */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Oid, RefName } from "./Api/Schema.ts";
import { StoreError } from "./Protocol/Store.ts";
import { incomingStates, type PushInput, type RefUpdate } from "./Push.ts";
import { makeStreamingSource } from "./Store/StreamingSource.ts";

const Commands = Schema.Array(
  Schema.Struct({ ref: RefName, oldOid: Oid, newOid: Oid }),
);

/**
 * Prepare input from decoded ref updates and raw pack bytes, with no HTTP dependency.
 * Use Stream.empty for a ref-only mutation. The input and producer share the caller's scope.
 */
export const fromStream = <E, R>(
  updates: ReadonlyArray<RefUpdate>,
  pack: Stream.Stream<Uint8Array, E, R>,
  options?: { readonly atomic?: boolean; readonly declaredBytes?: number },
) =>
  Effect.gen(function* () {
    const commands = yield* Schema.decodeUnknownEffect(Commands)(updates);
    const input: PushInput = Object.freeze({
      updates: Object.freeze(
        commands.map((command) => Object.freeze({ ...command })),
      ),
      atomic: options?.atomic ?? true,
    });
    const feeder = makeStreamingSource();
    let total = 0;
    const receiving = yield* Effect.forkScoped(
      pack.pipe(
        Stream.runForEach((bytes) =>
          Effect.andThen(
            feeder.push(bytes),
            Effect.sync(() => {
              total += bytes.length;
            }),
          ),
        ),
        Effect.map(() => {
          feeder.end();
          return { total };
        }),
        Effect.mapError(
          (error) =>
            new StoreError({ reason: `pack stream failed: ${String(error)}` }),
        ),
        Effect.tapError((error) => Effect.sync(() => feeder.fail(error))),
        Effect.result,
      ),
    );
    const state = {
      feeder,
      receiving,
      packStart: 0,
      declaredBytes: options?.declaredBytes,
      active: true,
      claimed: false,
    };
    incomingStates.set(input, state);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        state.active = false;
        feeder.fail(new StoreError({ reason: "push scope closed" }));
        yield* Fiber.interrupt(receiving);
      }),
    );
    return input;
  });
