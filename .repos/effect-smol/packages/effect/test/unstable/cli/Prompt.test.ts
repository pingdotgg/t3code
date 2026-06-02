import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Layer, Path, Redacted } from "effect"
import { TestConsole } from "effect/testing"
import { Prompt } from "effect/unstable/cli"
import * as MockTerminal from "./services/MockTerminal.ts"

const ConsoleLayer = TestConsole.layer
const FileSystemLayer = FileSystem.layerNoop({})
const PathLayer = Path.layer
const TerminalLayer = MockTerminal.layer

const TestLayer = Layer.mergeAll(
  ConsoleLayer,
  FileSystemLayer,
  PathLayer,
  TerminalLayer
)

const escape = String.fromCharCode(27)
const bell = String.fromCharCode(7)

const stripAnsi = (text: string) => {
  let result = ""
  let skipping = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (skipping) {
      if ((char >= "A" && char <= "Z") || (char >= "a" && char <= "z")) {
        skipping = false
      }
      continue
    }
    if (char === escape) {
      skipping = true
      continue
    }
    result += char
  }
  return result
}

const toFrames = (lines: ReadonlyArray<unknown>) =>
  lines
    .map((line) => stripAnsi(String(line)))
    .filter((line) => line.split(bell).join("").trim().length > 0)

const toRawFrames = (lines: ReadonlyArray<unknown>) =>
  lines
    .map((line) => String(line))
    .filter((line) => stripAnsi(line).split(bell).join("").trim().length > 0)

const findFrame = (frames: ReadonlyArray<string>, text: string) => frames.find((frame) => frame.includes(text))

describe("Prompt.integer", () => {
  it.effect("submits the default value", () =>
    Effect.gen(function*() {
      const prompt = Prompt.integer({ message: "Count", default: 42 })

      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, 42)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("starts from the default value so it can be edited", () =>
    Effect.gen(function*() {
      const prompt = Prompt.integer({ message: "Count", default: 4 })

      yield* MockTerminal.inputText("2")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, 42)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("clears the default value on ctrl-u", () =>
    Effect.gen(function*() {
      const prompt = Prompt.integer({ message: "Count", default: 42 })

      yield* MockTerminal.inputKey("u", { ctrl: true })
      yield* MockTerminal.inputText("7")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, 7)
    }).pipe(Effect.provide(TestLayer)))
})

describe("Prompt.float", () => {
  it.effect("renders appended input without literal parsed", () =>
    Effect.gen(function*() {
      const prompt = Prompt.float({ message: "Rate" })

      yield* MockTerminal.inputText("12.5")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, 12.5)

      const output = yield* TestConsole.logLines
      const frames = toFrames(output)
      const rendered = frames.join("\n")

      assert.isTrue(rendered.includes("12.5"))
      assert.isFalse(rendered.includes("parsed"))
    }).pipe(Effect.provide(TestLayer)))

  it.effect("clears the current input on ctrl-u", () =>
    Effect.gen(function*() {
      const prompt = Prompt.float({ message: "Rate" })

      yield* MockTerminal.inputText("12.5")
      yield* MockTerminal.inputKey("u", { ctrl: true })
      yield* MockTerminal.inputText("7.25")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, 7.25)
    }).pipe(Effect.provide(TestLayer)))
})

describe("Prompt.text", () => {
  it.effect("starts from the default value so it can be edited", () =>
    Effect.gen(function*() {
      const prompt = Prompt.text({
        message: "Name",
        default: "Jane"
      })

      yield* MockTerminal.inputText(" Doe")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "Jane Doe")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("clears the current input on ctrl-u", () =>
    Effect.gen(function*() {
      const prompt = Prompt.text({
        message: "Name",
        default: "Jane"
      })

      yield* MockTerminal.inputText(" Doe")
      yield* MockTerminal.inputKey("u", { ctrl: true })
      yield* MockTerminal.inputText("John")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "John")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("moves the cursor to the beginning on ctrl-a", () =>
    Effect.gen(function*() {
      const prompt = Prompt.text({
        message: "Name",
        default: "Jane"
      })

      yield* MockTerminal.inputText(" Doe")
      yield* MockTerminal.inputKey("a", { ctrl: true })
      yield* MockTerminal.inputText("Dr. ")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "Dr. Jane Doe")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("moves the cursor to the end on ctrl-e", () =>
    Effect.gen(function*() {
      const prompt = Prompt.text({
        message: "Name"
      })

      yield* MockTerminal.inputText("Jane")
      yield* MockTerminal.inputKey("left")
      yield* MockTerminal.inputKey("left")
      yield* MockTerminal.inputKey("e", { ctrl: true })
      yield* MockTerminal.inputText(" Doe")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "Jane Doe")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("does not insert characters for unsupported ctrl key combinations", () =>
    Effect.gen(function*() {
      const prompt = Prompt.text({
        message: "Name"
      })

      yield* MockTerminal.inputText("Ja")
      yield* MockTerminal.inputKey("l", { ctrl: true })
      yield* MockTerminal.inputText("ne")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "Jane")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("does not render or submit the cleared default value", () =>
    Effect.gen(function*() {
      const prompt = Prompt.text({
        message: "Name",
        default: "Jane"
      })

      yield* MockTerminal.inputKey("u", { ctrl: true })
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "")

      const output = yield* TestConsole.logLines
      const frames = toFrames(output)
      const lastFrame = frames.at(-1)

      assert.isTrue(lastFrame !== undefined)
      assert.isFalse(lastFrame?.includes("Jane"))
    }).pipe(Effect.provide(TestLayer)))
})

describe("Prompt.password", () => {
  it.effect("starts from the default value so it can be edited", () =>
    Effect.gen(function*() {
      const prompt = Prompt.password({
        message: "Password",
        default: "secret"
      })

      yield* MockTerminal.inputText("123")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(Redacted.value(result), "secret123")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("does not submit the cleared default value", () =>
    Effect.gen(function*() {
      const prompt = Prompt.password({
        message: "Password",
        default: "secret"
      })

      yield* MockTerminal.inputKey("u", { ctrl: true })
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(Redacted.value(result), "")
    }).pipe(Effect.provide(TestLayer)))
})

describe("Prompt.autoComplete", () => {
  it.effect("filters choices as you type", () =>
    Effect.gen(function*() {
      const prompt = Prompt.autoComplete({
        message: "Pick fruit",
        choices: [
          { title: "Apple", value: "apple" },
          { title: "Banana", value: "banana" },
          { title: "Cherry", value: "cherry" }
        ]
      })

      yield* MockTerminal.inputText("ban")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "banana")

      const output = yield* TestConsole.logLines
      const frames = toFrames(output)
      const filteredFrame = findFrame(frames, "[filter: ban]")

      assert.isTrue(filteredFrame !== undefined)
      assert.isTrue(filteredFrame?.includes("Banana"))
      assert.isFalse(filteredFrame?.includes("Apple"))
    }).pipe(Effect.provide(TestLayer)))

  it.effect("removes the last character on backspace", () =>
    Effect.gen(function*() {
      const prompt = Prompt.autoComplete({
        message: "Pick item",
        choices: [
          { title: "Alpha", value: "alpha" },
          { title: "Beta", value: "beta" },
          { title: "Delta", value: "delta" }
        ]
      })

      yield* MockTerminal.inputText("al")
      yield* MockTerminal.inputKey("backspace")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "alpha")

      const output = yield* TestConsole.logLines
      const frames = toFrames(output)
      const narrowedFrame = findFrame(frames, "[filter: al]")
      const expandedFrame = findFrame(frames, "[filter: a]")

      assert.isTrue(narrowedFrame !== undefined)
      assert.isTrue(expandedFrame !== undefined)
      assert.isFalse(narrowedFrame?.includes("Beta"))
      assert.isTrue(expandedFrame?.includes("Beta"))
    }).pipe(Effect.provide(TestLayer)))

  it.effect("clears the filter input on ctrl-u", () =>
    Effect.gen(function*() {
      const prompt = Prompt.autoComplete({
        message: "Pick item",
        choices: [
          { title: "Alpha", value: "alpha" },
          { title: "Beta", value: "beta" },
          { title: "Delta", value: "delta" }
        ]
      })

      yield* MockTerminal.inputText("al")
      yield* MockTerminal.inputKey("u", { ctrl: true })
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "alpha")

      const output = yield* TestConsole.logLines
      const frames = toFrames(output)
      const narrowedFrame = findFrame(frames, "[filter: al]")
      const clearedFrame = findFrame(frames, "[filter: type to filter]")

      assert.isTrue(narrowedFrame !== undefined)
      assert.isTrue(clearedFrame !== undefined)
      assert.isFalse(narrowedFrame?.includes("Beta"))
      assert.isTrue(clearedFrame?.includes("Beta"))
    }).pipe(Effect.provide(TestLayer)))

  it.effect("renders empty message and beeps on submit with no matches", () =>
    Effect.gen(function*() {
      const prompt = Prompt.autoComplete({
        message: "Pick pet",
        choices: [
          { title: "Cat", value: "cat" },
          { title: "Dog", value: "dog" }
        ]
      })

      yield* MockTerminal.inputText("zzz")
      yield* MockTerminal.inputKey("enter")
      for (let i = 0; i < 3; i++) {
        yield* MockTerminal.inputKey("backspace")
      }
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "cat")

      const output = yield* TestConsole.logLines
      const frames = toFrames(output)

      assert.isTrue(output.some((line) => String(line).includes("\x07")))
      assert.isTrue(findFrame(frames, "No matches") !== undefined)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("beeps when submitting a disabled choice", () =>
    Effect.gen(function*() {
      const prompt = Prompt.autoComplete({
        message: "Pick mode",
        choices: [
          { title: "Slow", value: "slow", disabled: true },
          { title: "Fast", value: "fast" }
        ]
      })

      yield* MockTerminal.inputKey("enter")
      yield* MockTerminal.inputKey("down")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "fast")

      const output = yield* TestConsole.logLines
      assert.isTrue(output.some((line) => String(line).includes("\x07")))
    }).pipe(Effect.provide(TestLayer)))

  it.effect("renders empty message with no choices", () =>
    Effect.gen(function*() {
      const prompt = Prompt.autoComplete({
        message: "Pick option",
        choices: []
      })

      yield* MockTerminal.inputKey("c", { ctrl: true })
      const exit = yield* Prompt.run(prompt).pipe(Effect.exit)
      assert.isTrue(exit._tag === "Failure")

      const output = yield* TestConsole.logLines
      const frames = toFrames(output)

      assert.isTrue(findFrame(frames, "No matches") !== undefined)
    }).pipe(Effect.provide(TestLayer)))
})

describe("Prompt.file", () => {
  const FilePromptLayer = Layer.mergeAll(
    ConsoleLayer,
    FileSystem.layerNoop({
      exists: () => Effect.succeed(true),
      readDirectory: (directory) =>
        Effect.succeed(
          directory === "/workspace"
            ? ["alpha.txt", "banana.txt", "basket.txt"]
            : []
        ),
      stat: (path) =>
        Effect.succeed(
          path.endsWith(".txt")
            ? ({ type: "File" } as any)
            : ({ type: "Directory" } as any)
        )
    }),
    PathLayer,
    TerminalLayer
  )

  it.effect("starts from the default value so it can be submitted", () =>
    Effect.gen(function*() {
      const prompt = Prompt.file({
        message: "Pick file",
        default: "/workspace/banana.txt"
      })

      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "/workspace/banana.txt")
    }).pipe(Effect.provide(FilePromptLayer)))

  it.effect("filters files as you type", () =>
    Effect.gen(function*() {
      const prompt = Prompt.file({
        message: "Pick file",
        startingPath: "/workspace"
      })

      yield* MockTerminal.inputText("ban")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "/workspace/banana.txt")

      const output = yield* TestConsole.logLines
      const frames = toFrames(output)
      const filteredFrame = findFrame(frames, "[filter: ban]")

      assert.isTrue(filteredFrame !== undefined)
      assert.isTrue(filteredFrame?.includes("banana.txt"))
      assert.isFalse(filteredFrame?.includes("alpha.txt"))
      assert.isFalse(filteredFrame?.includes("basket.txt"))
    }).pipe(Effect.provide(FilePromptLayer)))

  it.effect("removes the last character on backspace", () =>
    Effect.gen(function*() {
      const prompt = Prompt.file({
        message: "Pick file",
        startingPath: "/workspace"
      })

      yield* MockTerminal.inputText("ban")
      yield* MockTerminal.inputKey("backspace")
      yield* MockTerminal.inputKey("enter")

      const result = yield* Prompt.run(prompt)
      assert.strictEqual(result, "/workspace/banana.txt")

      const output = yield* TestConsole.logLines
      const frames = toFrames(output)
      const narrowedFrame = findFrame(frames, "[filter: ban]")
      const expandedFrame = findFrame(frames, "[filter: ba]")

      assert.isTrue(narrowedFrame !== undefined)
      assert.isTrue(expandedFrame !== undefined)
      assert.isFalse(narrowedFrame?.includes("basket.txt"))
      assert.isTrue(expandedFrame?.includes("basket.txt"))
    }).pipe(Effect.provide(FilePromptLayer)))
})

describe("Prompt.multiSelect", () => {
  it.effect("underlines the active label", () =>
    Effect.gen(function*() {
      const prompt = Prompt.multiSelect({
        message: "Pick items",
        choices: [
          { title: "Alpha", value: "alpha" },
          { title: "Beta", value: "beta" },
          { title: "Gamma", value: "gamma" }
        ]
      })

      const fiber = yield* Prompt.run(prompt).pipe(Effect.forkChild)

      yield* Effect.yieldNow
      yield* MockTerminal.inputKey("down")
      yield* MockTerminal.inputKey("down")
      yield* MockTerminal.inputKey("down")
      yield* Effect.yieldNow

      const output = yield* TestConsole.logLines
      const frames = toRawFrames(output)
      const highlightedFrame = [...frames].reverse().find((frame) => frame.includes("Beta"))

      assert.isTrue(highlightedFrame !== undefined)
      assert.isTrue(highlightedFrame?.includes(`${escape}[4m${escape}[96mBeta${escape}[0m`))

      yield* MockTerminal.inputKey("enter")

      const result = yield* Fiber.join(fiber)
      assert.deepStrictEqual(result, [])
    }).pipe(Effect.provide(TestLayer)))
})
