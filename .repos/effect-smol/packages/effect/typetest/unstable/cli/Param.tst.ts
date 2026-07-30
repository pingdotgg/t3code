import { Effect } from "effect"
import { Argument, Flag, Prompt } from "effect/unstable/cli"
import { describe, expect, it } from "tstyche"

describe("Param", () => {
  it("accepts effectful fallback prompts for flags and arguments", () => {
    const prompt = Effect.succeed(Prompt.text({ message: "Name" }))
    const integerPrompt = Effect.succeed(Prompt.integer({ message: "Count" }))

    const flag = Flag.string("name").pipe(Flag.withFallbackPrompt(prompt))
    const argument = Argument.string("name").pipe(Argument.withFallbackPrompt(prompt))
    const integerFlag = Flag.string("count").pipe(Flag.withFallbackPrompt(integerPrompt))
    const integerArgument = Argument.string("count").pipe(Argument.withFallbackPrompt(integerPrompt))

    expect(flag).type.toBe<Flag.Flag<string>>()
    expect(argument).type.toBe<Argument.Argument<string>>()
    expect(integerFlag).type.toBe<Flag.Flag<string | number>>()
    expect(integerArgument).type.toBe<Argument.Argument<string | number>>()
  })
})
