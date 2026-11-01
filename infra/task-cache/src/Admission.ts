import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class AdmissionRejected extends Schema.TaggedError<AdmissionRejected>()(
  "AdmissionRejected",
  {},
) {}

export class Admission extends Context.Service<
  Admission,
  {
    readonly withPermit: <A, E, R>(
      store: boolean,
      task: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | AdmissionRejected, R>;
  }
>()("@t3tools/task-cache/Admission") {}

const make = Effect.gen(function* () {
  // Never queue fibers across Worker requests: their async contexts cannot cross request boundaries.
  const stores = yield* Semaphore.make(2);
  const reads = yield* Semaphore.make(4);
  return Admission.of({
    // The caller owns the request span; admission adds no second span per request.
    withPermit: Effect.fnUntraced(function* (store, task) {
      const result = yield* (store ? stores : reads).withPermitsIfAvailable(1)(task);
      return Option.isSome(result) ? result.value : yield* new AdmissionRejected();
    }),
  });
});

export const layer = Layer.effect(Admission, make);
