import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** Buffer parent events before opening the child watch so a replacement cannot strand it. */
export const watchDirectoryReplacements = (
  watchParent: (ready: Deferred.Deferred<void>) => Stream.Stream<unknown, unknown>,
  watchChild: Stream.Stream<void>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const replacements = yield* watchParent(ready).pipe(
        Stream.ignoreCause({ log: true }),
        Stream.ensuring(Deferred.succeed(ready, undefined)),
        Stream.toQueue({ capacity: 1, strategy: "sliding" }),
      );
      yield* Deferred.await(ready);

      return Stream.make(watchChild).pipe(
        Stream.concat(Stream.fromQueue(replacements).pipe(Stream.as(watchChild))),
        Stream.switchMap((events) => events),
      );
    }),
  );
