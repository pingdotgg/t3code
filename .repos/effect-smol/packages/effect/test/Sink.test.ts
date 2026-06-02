import { describe, it } from "@effect/vitest"
import {
  assertExitFailure,
  assertExitSuccess,
  assertNone,
  assertSome,
  deepStrictEqual,
  strictEqual
} from "@effect/vitest/utils"
import { Array, Cause, Effect, Option, Ref, Result, Sink, Stream } from "effect"
import { constTrue, pipe } from "effect/Function"

describe("Sink", () => {
  describe("reduceWhile", () => {
    it.effect("empty", () =>
      Effect.gen(function*() {
        const result = yield* Stream.empty.pipe(
          Stream.transduce(Sink.reduceWhile<number, number>(() => 0, constTrue, (x, y) => x + y)),
          Stream.runCollect
        )
        deepStrictEqual(result, [0])
      }))

    it.effect("termination in the middle", () =>
      Effect.gen(function*() {
        const result = yield* Stream.range(1, 9).pipe(
          Stream.run(Sink.reduceWhile<number, number>(() => 0, (n) => n <= 5, (x, y) => x + y))
        )
        strictEqual(result, 6)
      }))

    it.effect("immediate termination", () =>
      Effect.gen(function*() {
        const result = yield* Stream.range(1, 9).pipe(
          Stream.run(Sink.reduceWhile<number, number>(() => 0, (n) => n <= -1, (x, y) => x + y))
        )
        strictEqual(result, 0)
      }))

    it.effect("no termination", () =>
      Effect.gen(function*() {
        const result = yield* Stream.range(1, 9).pipe(
          Stream.run(Sink.reduceWhile<number, number>(() => 0, (n) => n <= 500, (x, y) => x + y))
        )
        strictEqual(result, 45)
      }))
  })
  describe("reduceWhileEffect", () => {
    it.effect("short circuits", () =>
      Effect.gen(function*() {
        const empty: Stream.Stream<number> = Stream.empty
        const single = Stream.make(1)
        const double = Stream.make(1, 2)
        const failed = Stream.fail("Ouch")
        const run = <E>(stream: Stream.Stream<number, E>) =>
          Ref.make(Array.empty<number>()).pipe(
            Effect.flatMap((ref) =>
              stream.pipe(
                Stream.transduce(Sink.reduceWhileEffect(
                  () => 0,
                  constTrue,
                  (_, y: number) => Effect.as(Ref.update(ref, Array.append(y)), 30)
                )),
                Stream.runCollect,
                Effect.flatMap((exit) =>
                  Ref.get(ref).pipe(
                    Effect.map((result) => [exit, result])
                  )
                )
              )
            ),
            Effect.exit
          )
        const result1 = yield* run(empty)
        const result2 = yield* run(single)
        const result3 = yield* run(double)
        const result4 = yield* run(failed)
        assertExitSuccess(result1, [[0], []])
        assertExitSuccess(result2, [[30], [1]])
        assertExitSuccess(result3, [[30], [1, 2]])
        assertExitFailure(result4, Cause.fail("Ouch"))
      }))
  })

  describe("reduce", () => {
    it.effect("equivalence with Array.reduce", () =>
      Effect.gen(function*() {
        const stream = Stream.range(1, 9)
        const result1 = yield* stream.pipe(Stream.run(Sink.reduce(() => "", (s, n) => s + `${n}`)))
        const result2 = yield* stream.pipe(
          Stream.runCollect,
          Effect.map(Array.reduce("", (s, n) => s + `${n}`))
        )
        strictEqual(result1, result2)
      }))
  })

  describe("take", () => {
    it.effect("respects the given limit", () =>
      Effect.gen(function*() {
        const stream = Stream.make(1, 2, 3, 4).pipe(
          Stream.transduce(Sink.take<number>(3))
        )
        const result = yield* Stream.runCollect(stream)
        deepStrictEqual(
          result,
          [[1, 2, 3], [4]]
        )
      }))

    it.effect("produces empty trailing chunks", () =>
      Effect.gen(function*() {
        const stream = Stream.make(1, 2, 3, 4).pipe(
          Stream.transduce(Sink.take<number>(4))
        )
        const result = yield* Stream.runCollect(stream)
        deepStrictEqual(
          result,
          [[1, 2, 3, 4], []]
        )
      }))

    it.effect("produces an empty chunk for empty input", () =>
      Effect.gen(function*() {
        const stream = Stream.empty.pipe(
          Stream.transduce(Sink.take<number>(3))
        )
        const result = yield* Stream.runCollect(stream)
        deepStrictEqual(result, [[]])
      }))
  })

  describe("takeWhile", () => {
    it.effect("takeWhile", () =>
      Effect.gen(function*() {
        const result = yield* Stream.make(1, 2, 3, 4).pipe(
          Stream.run(Sink.takeWhile((n) => n < 3))
        )
        deepStrictEqual(result, [1, 2])
      }))

    it.effect("takeWhileFilter", () =>
      Effect.gen(function*() {
        const result = yield* Stream.make(1, 2, 3, 4).pipe(
          Stream.run(Sink.takeWhileFilter((n) => n < 3 ? Result.succeed(n * 2) : Result.failVoid))
        )
        deepStrictEqual(result, [2, 4])
      }))

    it.effect("takeWhileFilter consumes the first failing input", () =>
      Effect.gen(function*() {
        const result = yield* Stream.make(1, 2, 3, 4).pipe(
          Stream.transduce(Sink.takeWhileFilter((n) => n < 3 ? Result.succeed(n) : Result.failVoid)),
          Stream.runCollect
        )
        deepStrictEqual(result, [[1, 2], [], []])
      }))

    it.effect("takeWhileEffect", () =>
      Effect.gen(function*() {
        const result = yield* Stream.make(1, 2, 3, 4).pipe(
          Stream.run(Sink.takeWhileEffect((n) => Effect.succeed(n < 3)))
        )
        deepStrictEqual(result, [1, 2])
      }))

    it.effect("takeWhileFilterEffect", () =>
      Effect.gen(function*() {
        const result = yield* Stream.make(1, 2, 3, 4).pipe(
          Stream.run(Sink.takeWhileFilterEffect((n) => Effect.succeed(n < 3 ? Result.succeed(n + 1) : Result.failVoid)))
        )
        deepStrictEqual(result, [2, 3])
      }))

    it.effect("takeWhileFilterEffect consumes the first failing input", () =>
      Effect.gen(function*() {
        const result = yield* Stream.make(1, 2, 3, 4).pipe(
          Stream.transduce(
            Sink.takeWhileFilterEffect((n) => Effect.succeed(n < 3 ? Result.succeed(n) : Result.failVoid))
          ),
          Stream.runCollect
        )
        deepStrictEqual(result, [[1, 2], [], []])
      }))
  })

  describe("flatMap", () => {
    it.effect("flatMap - empty input", () =>
      Effect.gen(function*() {
        const sink = pipe(Sink.head<number>(), Sink.flatMap(Sink.succeed))
        const result = yield* pipe(Stream.empty, Stream.run(sink))
        assertNone(result)
      }))

    it.effect("flatMap - non-empty input", () =>
      Effect.gen(function*() {
        const sink = pipe(Sink.head<number>(), Sink.flatMap(Sink.succeed))
        const result = yield* pipe(Stream.make(1, 2, 3), Stream.run(sink))
        assertSome(result, 1)
      }))

    it.effect("flatMap - with leftovers", () =>
      Effect.gen(function*() {
        const chunks = Array.make(
          Array.make(1, 2),
          Array.make(3, 4, 5),
          Array.empty<number>(),
          Array.make(7, 8, 9, 10)
        )
        const sink = pipe(
          Sink.head<number>(),
          Sink.flatMap((head) =>
            pipe(
              Sink.count,
              Sink.map((count) => [head, count] as const)
            )
          )
        )
        const [option, count] = yield* pipe(Stream.fromArrays(...chunks), Stream.run(sink))
        deepStrictEqual(option, Array.head(Array.flatten(chunks)))
        strictEqual(
          count + Option.match(option, {
            onNone: () => 0,
            onSome: () => 1
          }),
          chunks.flat().length
        )
      }))
  })
})
