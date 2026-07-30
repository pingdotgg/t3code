import { Effect, Match, type Queue, type Terminal } from "effect"
import { Prompt } from "effect/unstable/cli"
import { describe, expect, it } from "tstyche"

declare const stringEvents: Queue.Dequeue<string, never>
declare const objectEvents: Queue.Dequeue<{ readonly tick: number }, never>

describe("Prompt", () => {
  describe("custom", () => {
    it("without events, process receives Terminal.UserInput", () => {
      Prompt.custom(
        { count: 0 },
        {
          render: () => Effect.succeed(""),
          process: (input, _state) => {
            expect(input).type.toBe<Terminal.UserInput>()
            return Effect.succeed({ _tag: "Submit" as const, value: 42 })
          },
          clear: () => Effect.succeed("")
        }
      )
    })

    it("with events, process receives ProcessInput<A>", () => {
      Prompt.custom(
        { count: 0 },
        stringEvents,
        {
          render: () => Effect.succeed(""),
          process: (input, _state) => {
            expect(input).type.toBe<Prompt.ProcessInput<string>>()
            return Effect.succeed({ _tag: "Submit" as const, value: 42 })
          },
          clear: () => Effect.succeed("")
        }
      )
    })

    it("ProcessInput is a discriminated union narrowed by _tag", () => {
      Prompt.custom(
        { count: 0 },
        objectEvents,
        {
          render: () => Effect.succeed(""),
          process: (input, _state) => {
            if (input._tag === "Input") {
              expect(input.input).type.toBe<Terminal.UserInput>()
            } else {
              expect(input.value).type.toBe<{ readonly tick: number }>()
            }
            return Effect.succeed({ _tag: "Submit" as const, value: 0 })
          },
          clear: () => Effect.succeed("")
        }
      )
    })

    it("returns Prompt<Output>", () => {
      const prompt = Prompt.custom(
        0,
        {
          render: () => Effect.succeed(""),
          process: ({ key }, state) =>
            Effect.succeed(
              key.name === "enter" ? { _tag: "Submit" as const, value: state } : { _tag: "Beep" as const }
            ),
          clear: () => Effect.succeed("")
        }
      )

      expect(prompt).type.toBe<Prompt.Prompt<number>>()
    })

    it("returns Prompt<Output> with events", () => {
      const prompt = Prompt.custom(
        0,
        stringEvents,
        {
          render: () => Effect.succeed(""),
          process: (input, state) =>
            Effect.succeed(
              Match.value(input).pipe(
                Match.tag("Input", ({ input }) =>
                  input.key.name === "enter" ? { _tag: "Submit" as const, value: state } : { _tag: "Beep" as const }),
                Match.tag("Event", ({ value }) =>
                  value === "tick" ? { _tag: "NextFrame" as const, state: state + 1 } : { _tag: "Beep" as const }),
                Match.exhaustive
              )
            ),
          clear: () => Effect.succeed("")
        }
      )

      expect(prompt).type.toBe<Prompt.Prompt<number>>()
    })
  })
})
