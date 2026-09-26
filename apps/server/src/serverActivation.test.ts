import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import { forkParked, ServerActivation, forkScopedDetached } from "./serverActivation.ts";

it.effect("forkParked detaches the activation wait and keeps the same root after release", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ambient = Tracer.externalSpan({
        traceId: "00000000000000000000000000000003",
        spanId: "0000000000000003",
        sampled: true,
      });
      const gate = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<Option.Option<Tracer.AnySpan>>();
      const running = yield* Deferred.make<Tracer.AnySpan>();
      const activation = Effect.gen(function* () {
        const parent = yield* Effect.serviceOption(Tracer.ParentSpan);
        yield* Deferred.succeed(waiting, parent);
        yield* Deferred.await(gate);
      });

      yield* forkParked(
        Effect.service(Tracer.ParentSpan).pipe(
          Effect.flatMap((parent) => Deferred.succeed(running, parent)),
        ),
      ).pipe(
        Effect.provideService(ServerActivation, activation),
        Effect.provideService(Tracer.ParentSpan, ambient),
      );

      const parent = Option.getOrThrow(yield* Deferred.await(waiting));
      expect(parent).not.toBe(ambient);
      expect(yield* Deferred.isDone(running)).toBe(false);
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Deferred.await(running)).toBe(parent);
    }),
  ),
);

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

it.effect("forkScopedDetached re-roots instead of inheriting the ambient ParentSpan", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ambient = Tracer.externalSpan({
        traceId: "00000000000000000000000000000001",
        spanId: "0000000000000001",
        sampled: true,
      });

      const detachedSpanId = yield* Effect.serviceOption(Tracer.ParentSpan).pipe(
        Effect.map(Option.map((span) => span.spanId)),
        forkScopedDetached,
        Effect.flatMap(Fiber.join),
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
  ),
);

it.effect(
  "forkScopedDetached keeps ParentSpan-requiring effects working under the fresh root",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const span = yield* Effect.service(Tracer.ParentSpan).pipe(
          forkScopedDetached,
          Effect.flatMap(Fiber.join),
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
    ),
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

// Inspect actual context references, including Effect's overlay/base/cache roots.
// Service lookup alone hides replaced spans that are still retained underneath.
const retainsReference = (root: unknown, target: object): boolean => {
  const seen = new Set<object>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === target) return true;
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    pending.push(...(value instanceof Map ? value.values() : Object.values(value)));
  }
  return false;
};

for (const gated of [false, true]) {
  it.effect(`forkParked drops retained parent references (${gated ? "gated" : "immediate"})`, () =>
    Effect.gen(function* () {
      const ambient = Tracer.externalSpan({ traceId: "ambient", spanId: "ambient" });
      const marker = Context.Service<{ readonly value: number }>("test/detached-marker");
      const service = { value: 42 };
      const observed = yield* Deferred.make<Context.Context<never>>();
      const stopped = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const observe = Effect.context<never>().pipe(
            Effect.flatMap((context) => Deferred.succeed(observed, context)),
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          );
          yield* forkParked(gated ? Effect.void : observe).pipe(
            Effect.provideService(ServerActivation, gated ? observe : undefined),
            Effect.provideService(marker, service),
            Effect.provideService(Tracer.ParentSpan, ambient),
          );
          const context = yield* Deferred.await(observed);
          expect(Context.getUnsafe(context, marker)).toBe(service);
          expect(retainsReference(context, ambient)).toBe(false);
        }),
      );
      expect(yield* Deferred.isDone(stopped)).toBe(true);
    }),
  );
}

it.effect("forkScopedDetached gives the child a detached context before it starts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ambient = Tracer.externalSpan({ traceId: "ambient", spanId: "ambient" });
      yield* Effect.gen(function* () {
        const fiber = yield* forkScopedDetached(Effect.never);
        expect(retainsReference(fiber.context, ambient)).toBe(false);
        expect(yield* Tracer.ParentSpan).toBe(ambient);
      }).pipe(Effect.provideService(Tracer.ParentSpan, ambient));
    }),
  ),
);
