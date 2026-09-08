import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { ApiDiff, type ApiDiffOptions } from "./ApiDiff.ts"

const baseRef = Flag.string("base-ref").pipe(
  Flag.withDescription("Explicit base Git ref"),
  Flag.withDefault("v3")
)

const headRef = Flag.string("head-ref").pipe(
  Flag.withDescription("Explicit head Git ref"),
  Flag.withDefault("main")
)

const output = Flag.string("output").pipe(
  Flag.withMetavar("DIRECTORY"),
  Flag.withDescription("Report output directory"),
  Flag.optional
)

const writeDoc = Flag.string("write-doc").pipe(
  Flag.withMetavar("FILE"),
  Flag.withDescription("Write the annotation-driven migration reference"),
  Flag.optional
)

const check = Flag.boolean("check").pipe(
  Flag.withDescription("List APIs without migration annotations and fail if any remain"),
  Flag.withDefault(false)
)

const runApiDiff = Effect.fnUntraced(function*(options: {
  readonly baseRef: string
  readonly headRef: string
  readonly output: Option.Option<string>
  readonly writeDoc: Option.Option<string>
  readonly check: boolean
}) {
  const apiDiff = yield* ApiDiff
  yield* apiDiff.run(
    {
      baseRef: options.baseRef,
      headRef: options.headRef,
      output: Option.getOrUndefined(options.output),
      writeDoc: Option.getOrUndefined(options.writeDoc),
      check: options.check
    } satisfies ApiDiffOptions
  )
})

export const cli = Command.make("api-diff", {
  baseRef,
  headRef,
  output,
  writeDoc,
  check
}).pipe(
  Command.withDescription("Compare the consumer-visible TypeScript API of two repository revisions"),
  Command.withHandler(runApiDiff)
)
