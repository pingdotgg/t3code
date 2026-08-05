import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import { forkParked, ServerActivation, withoutAmbientParentSpan } from "./serverActivation.ts";

it.effect("proves a root is parked before returning and releases it with one gate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const ran = yield* Deferred.make<void>();

      yield* forkParked(Deferred.succeed(ran, undefined)).pipe(
        Effect.provideService(ServerActivation, Deferred.await(activation)),
      );
      expect(yield* Deferred.isDone(ran)).toBe(false);

      yield* Deferred.succeed(activation, undefined);
      yield* Deferred.await(ran);
      expect(yield* Deferred.isDone(ran)).toBe(true);
    }),
  ),
);

it.effect("withoutAmbientParentSpan drops inherited ParentSpan for long-lived roots", () =>
  Effect.gen(function* () {
    const ambient = Tracer.externalSpan({
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
      sampled: true,
    });

    const sawParent = yield* Effect.serviceOption(Tracer.ParentSpan).pipe(
      Effect.map(Option.isSome),
      withoutAmbientParentSpan,
      Effect.provideService(Tracer.ParentSpan, ambient),
    );

    expect(sawParent).toBe(false);

    const stillHasParent = yield* Effect.serviceOption(Tracer.ParentSpan).pipe(
      Effect.map(Option.isSome),
      Effect.provideService(Tracer.ParentSpan, ambient),
    );
    expect(stillHasParent).toBe(true);

    const stripped = Context.omit(Tracer.ParentSpan)(Context.make(Tracer.ParentSpan, ambient));
    expect(Context.getOption(stripped, Tracer.ParentSpan)._tag).toBe("None");
  }),
);
