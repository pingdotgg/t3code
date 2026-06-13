import { type Cause, Data, type Effect, pipe, type Queue, Result, type Scope, Stream } from "effect"
import { describe, expect, it } from "tstyche"

class ErrorA extends Data.TaggedError("ErrorA")<{
  readonly message: string
}> {}

class ErrorB extends Data.TaggedError("ErrorB")<{
  readonly code: number
}> {}

declare const stream: Stream.Stream<string, ErrorA | ErrorB, "dep-1">
declare const predicate: (error: ErrorA | ErrorB) => boolean

class RateLimit extends Data.TaggedError("RateLimit")<{ readonly retryAfter: number }> {}
class Quota extends Data.TaggedError("Quota")<{ readonly limit: number }> {}
class AiError extends Data.TaggedError("AiError")<{ readonly reason: RateLimit | Quota }> {}

declare const aiStream: Stream.Stream<string, AiError | ErrorB, "dep-1">

describe("Stream.catchIf", () => {
  it("supports refinement in data-last usage", () => {
    const result = pipe(
      stream,
      Stream.catchIf(
        (error): error is ErrorA => error._tag === "ErrorA",
        (error) => {
          expect(error).type.toBe<ErrorA>()
          return Stream.succeed("recovered")
        }
      )
    )
    expect(result).type.toBe<Stream.Stream<string, ErrorB, "dep-1">>()
  })

  it("supports refinement with orElse", () => {
    const result = pipe(
      stream,
      Stream.catchIf(
        (error): error is ErrorA => error._tag === "ErrorA",
        () => Stream.succeed(1),
        (error) => {
          expect(error).type.toBe<ErrorB>()
          return Stream.succeed(2)
        }
      )
    )
    expect(result).type.toBe<Stream.Stream<string | number, never, "dep-1">>()
  })

  it("supports predicate in data-first usage", () => {
    const result = Stream.catchIf(
      stream,
      predicate,
      (error) => {
        expect(error).type.toBe<ErrorA | ErrorB>()
        return Stream.succeed(0)
      }
    )
    expect(result).type.toBe<Stream.Stream<string | number, ErrorA | ErrorB, "dep-1">>()
  })

  // Soundness guard for https://github.com/Effect-TS/effect-smol/issues/2142
  it("keeps unhandled errors under an explicit annotation (orElse omitted)", () => {
    // @ts-expect-error is not assignable to type 'Stream<string, never, "dep-1">'
    const _s: Stream.Stream<string, never, "dep-1"> = pipe(
      stream,
      Stream.catchIf((error): error is ErrorA => error._tag === "ErrorA", () => Stream.succeed("ok"))
    )
    expect(_s).type.toBe<Stream.Stream<string, never, "dep-1">>()
  })
})

describe("Stream.catchFilter", () => {
  it("removes the matched error when orElse is omitted", () => {
    const result = pipe(
      stream,
      Stream.catchFilter(
        (error) => (error._tag === "ErrorA" ? Result.succeed(error) : Result.fail(error)),
        () => Stream.succeed("ok")
      )
    )
    expect(result).type.toBe<Stream.Stream<string, ErrorB, "dep-1">>()
  })

  it("keeps unhandled errors under an explicit annotation (orElse omitted)", () => {
    // @ts-expect-error is not assignable to type 'Stream<string, never, "dep-1">'
    const _s: Stream.Stream<string, never, "dep-1"> = pipe(
      stream,
      Stream.catchFilter(
        (error) => (error._tag === "ErrorA" ? Result.succeed(error) : Result.fail(error)),
        () => Stream.succeed("ok")
      )
    )
    expect(_s).type.toBe<Stream.Stream<string, never, "dep-1">>()
  })
})

describe("Stream.catchTag", () => {
  it("removes the handled error when orElse is omitted", () => {
    const result = pipe(stream, Stream.catchTag("ErrorA", () => Stream.succeed("ok")))
    expect(result).type.toBe<Stream.Stream<string, ErrorB, "dep-1">>()
  })

  it("supports orElse that re-fails", () => {
    const result = pipe(
      stream,
      Stream.catchTag("ErrorA", () => Stream.succeed("ok"), () => Stream.fail(new ErrorB({ code: 1 })))
    )
    expect(result).type.toBe<Stream.Stream<string, ErrorB, "dep-1">>()
  })

  // Soundness guard for https://github.com/Effect-TS/effect-smol/issues/2142
  it("keeps unhandled errors under an explicit annotation (orElse omitted)", () => {
    // @ts-expect-error is not assignable to type 'Stream<string, never, "dep-1">'
    const _s: Stream.Stream<string, never, "dep-1"> = pipe(
      stream,
      Stream.catchTag("ErrorA", () => Stream.succeed("ok"))
    )
    expect(_s).type.toBe<Stream.Stream<string, never, "dep-1">>()
  })
})

describe("Stream.catchTags", () => {
  it("removes handled errors when orElse is omitted", () => {
    const result = pipe(stream, Stream.catchTags({ ErrorA: () => Stream.succeed("ok") }))
    expect(result).type.toBe<Stream.Stream<string, ErrorB, "dep-1">>()
  })

  it("keeps unhandled errors under an explicit annotation (orElse omitted)", () => {
    // @ts-expect-error is not assignable to type 'Stream<string, never, "dep-1">'
    const _s: Stream.Stream<string, never, "dep-1"> = pipe(
      stream,
      Stream.catchTags({ ErrorA: () => Stream.succeed("ok") })
    )
    expect(_s).type.toBe<Stream.Stream<string, never, "dep-1">>()
  })

  it("keeps the orElse error type when orElse re-fails", () => {
    const result = pipe(
      stream,
      Stream.catchTags(
        { ErrorA: () => Stream.succeed("ok") },
        (error) => {
          expect(error).type.toBe<ErrorB>()
          return Stream.fail(new RateLimit({ retryAfter: 1 }))
        }
      )
    )
    expect(result).type.toBe<Stream.Stream<string, RateLimit, "dep-1">>()
  })
})

describe("Stream.catchReason", () => {
  it("keeps other error tags when orElse re-fails", () => {
    const result = pipe(
      aiStream,
      Stream.catchReason(
        "AiError",
        "RateLimit",
        () => Stream.succeed("ok"),
        () => Stream.fail(new ErrorA({ message: "x" }))
      )
    )
    expect(result).type.toBe<Stream.Stream<string, ErrorA | ErrorB, "dep-1">>()
  })
})

describe("Stream.catchReasons", () => {
  it("keeps other error tags when orElse re-fails", () => {
    const result = pipe(
      aiStream,
      Stream.catchReasons(
        "AiError",
        { RateLimit: () => Stream.succeed("ok") },
        () => Stream.fail(new ErrorA({ message: "x" }))
      )
    )
    expect(result).type.toBe<Stream.Stream<string, ErrorA | ErrorB, "dep-1">>()
  })
})

describe("Stream.toQueue", () => {
  it("supports data-last usage", () => {
    const result = pipe(stream, Stream.toQueue({ capacity: 16 }))
    expect(result).type.toBe<
      Effect.Effect<Queue.Dequeue<string, ErrorA | ErrorB | Cause.Done>, never, "dep-1" | Scope.Scope>
    >()
  })

  it("supports data-first usage", () => {
    const result = Stream.toQueue(stream, { capacity: "unbounded" })
    expect(result).type.toBe<
      Effect.Effect<Queue.Dequeue<string, ErrorA | ErrorB | Cause.Done>, never, "dep-1" | Scope.Scope>
    >()
  })
})
