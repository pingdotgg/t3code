import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import { forkParked, ServerActivation, withDetachedSpan } from "./serverActivation.ts";

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

it.effect("withDetachedSpan re-roots instead of inheriting the ambient ParentSpan", () =>
  Effect.gen(function* () {
    const ambient = Tracer.externalSpan({
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
      sampled: true,
    });

    const detachedSpanId = yield* Effect.serviceOption(Tracer.ParentSpan).pipe(
      Effect.map(Option.map((span) => span.spanId)),
      withDetachedSpan,
      Effect.provideService(Tracer.ParentSpan, ambient),
    );
    expect(Option.isSome(detachedSpanId)).toBe(true);
    if (Option.isSome(detachedSpanId)) {
      expect(detachedSpanId.value).not.toBe("0000000000000001");
    }

    const stillHasParent = yield* Effect.serviceOption(Tracer.ParentSpan).pipe(
      Effect.map(Option.map((span) => span.spanId)),
      Effect.provideService(Tracer.ParentSpan, ambient),
    );
    expect(Option.isSome(stillHasParent)).toBe(true);
    if (Option.isSome(stillHasParent)) {
      expect(stillHasParent.value).toBe("0000000000000001");
    }
  }),
);

it.effect("withDetachedSpan keeps ParentSpan-requiring effects working under the fresh root", () =>
  Effect.gen(function* () {
    const span = yield* Effect.service(Tracer.ParentSpan).pipe(
      withDetachedSpan,
      Effect.provideService(
        Tracer.ParentSpan,
        Tracer.externalSpan({
          traceId: "00000000000000000000000000000001",
          spanId: "0000000000000001",
          sampled: true,
        }),
      ),
    );
    expect(span.spanId).not.toBe("0000000000000001");
  }),
);

it.effect("forkParked roots do not inherit the ambient ParentSpan", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ambient = Tracer.externalSpan({
        traceId: "00000000000000000000000000000002",
        spanId: "0000000000000002",
        sampled: true,
      });
      const observed = yield* Deferred.make<Option.Option<string>>();

      yield* forkParked(
        Effect.serviceOption(Tracer.ParentSpan).pipe(
          Effect.map(Option.map((span) => span.spanId)),
          Effect.flatMap((spanId) => Deferred.succeed(observed, spanId)),
        ),
      ).pipe(Effect.provideService(Tracer.ParentSpan, ambient));

      const spanId = yield* Deferred.await(observed);
      expect(Option.isSome(spanId)).toBe(true);
      if (Option.isSome(spanId)) {
        expect(spanId.value).not.toBe("0000000000000002");
      }
    }),
  ),
);
