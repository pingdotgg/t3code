import * as Escape from "@effect/chat-slack/internal/escape"
import * as Text from "@effect/chat-slack/internal/text"
import * as SlackChat from "@effect/chat-slack/SlackChat"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { adapter, channel, makeFake, slackLayer, team } from "./utils.ts"

const codePoints = (text: string) => [...text].length
const bytes = (text: string) => new TextEncoder().encode(text).length
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const graphemes = (text: string) => [...segmenter.segment(text)]
const isBoundary = (text: string, index: number) =>
  index === text.length || graphemes(text).some((segment) => segment.index === index)

/**
 * The CI half of the Slack mention rule: the same assertions the live rule
 * makes on stored messages, made here on the request bodies the adapter
 * builds for `chat.postMessage` and `chat.update`. Stream appends are under
 * "stream bodies".
 */
describe("request bodies", () => {
  const thread = SlackChat.thread({ team, channel })
  const allowed = { users: ["U1"], broadcast: true }
  /** The tokens `notify` lets through, of those the alphabet can spell. */
  const allowedTokens = (notify: Escape.Notify): ReadonlyArray<string> => [
    ...(notify.users?.includes("U1") ? ["<@U1>"] : []),
    ...(notify.broadcast === true ? ["<!here>"] : [])
  ]

  // Pieces that spell tokens, entity forms, code and multi-unit characters.
  const alphabet = ["<", "@U1", "!here", ">", "&", "lt;", "`", "x", "👍🏽", "\n"]
  const words = (length: number): Array<string> =>
    length === 0 ? [""] : words(length - 1).flatMap((word) => alphabet.map((piece) => word + piece))
  const short = [1, 2, 3].flatMap(words)
  const withToken = short.filter((word) => word.includes("<"))

  /** Repeats `word` until the text is past both budgets while the block stays within 12,000. */
  const long = (word: string, notify: Escape.Notify): string => {
    const sent = (markdown: string) => codePoints(Escape.escape(markdown, notify, { flush: true }).sent)
    let times = Math.floor(11_900 / sent(word))
    while (sent(word.repeat(times)) > 12_000) times = Math.floor(times / 2)
    return word.repeat(times)
  }

  const check = (op: "post" | "edit", markdown: string, notify: Escape.Notify, params: Record<string, string>) => {
    const label = `${op} ${JSON.stringify(markdown.slice(0, 40))} ${JSON.stringify(notify)}`
    const block = JSON.parse(params.blocks)[0].text as string
    const text = params.text
    assert.isUndefined(params.markdown_text, label)
    assert.isAbove(text.length, 0, label)
    if (op === "post") assert.isAtMost(codePoints(text), Text.postTextLength, label)
    else assert.isAtMost(bytes(text), Text.updateTextBytes, label)
    // No token survives in text but an allowed one, and every & starts an entity.
    let rest = text
    for (const token of allowedTokens(notify)) rest = rest.replaceAll(token, "")
    assert.notMatch(rest, /[<>]|&(?!lt;|gt;|amp;)/, label)
    // An allowed token the block sends intact is in text too, cut or not.
    for (const token of allowedTokens(notify)) {
      if (block.includes(token)) assert.include(text, token, label)
    }
    // A cut is a prefix of the whole text, on a grapheme boundary and outside an entity.
    const whole = Text.build(markdown, notify, { unit: "codePoints", limit: Infinity }).text
    if (text !== whole) {
      const head = text.slice(0, text.lastIndexOf("…"))
      assert.isTrue(whole.startsWith(head), label)
      assert.notMatch(head, /&[a-z]*$/, label)
      assert.isTrue(isBoundary(whole, head.length), label)
    }
  }

  it.effect("hold the mention, budget and cut rules over a generated alphabet", () => {
    const fake = makeFake({ "chat.postMessage": { ok: true, channel, ts: "1.1" } })
    return Effect.gen(function*() {
      const slack = yield* adapter
      let count = 0
      let cuts = 0
      for (const notify of [{}, allowed] as ReadonlyArray<Escape.Notify>) {
        const inputs = [
          ...short,
          ...[1, 2].flatMap(words).map((word) => long(word, notify)),
          // 3,300 `&` are 16,500 code points of text, so a token in the word is past either cut.
          ...(notify === allowed ? withToken.map((word) => "&".repeat(3_300) + word) : [])
        ]
        for (const markdown of inputs) {
          for (const op of ["post", "edit"] as const) {
            const before = fake.calls.length
            // A new message id for each edit, so pacing never waits.
            const write = op === "post"
              ? slack.post(thread, { markdown })
              : slack.edit(thread, `1.${count + 2}`, { markdown })
            yield* write.pipe(SlackChat.withPostOptions({ notify }))
            const call = fake.calls[fake.calls.length - 1]
            assert.strictEqual(fake.calls.length, before + 1)
            assert.strictEqual(call.method, op === "post" ? "chat.postMessage" : "chat.update")
            check(op, markdown, notify, call.params)
            if (call.params.text.includes("…")) cuts++
            count++
          }
        }
      }
      assert.strictEqual(count, 2 * (2 * (short.length + 110) + withToken.length))
      // The long inputs reach both budgets.
      assert.isAbove(cuts, 2 * withToken.length)
    }).pipe(Effect.provide(slackLayer(fake)))
  }, 60_000)
})

/**
 * The CI half of the Slack mention rule for a stream: every input split at
 * every position, across two appends with the held tail sent again as the
 * layer does, and across the start and an append, where nothing is held.
 * Slack joins a reference split across writes, so the check is on what the
 * writes add up to, decoded. Forms without a semicolon decode to nothing, so
 * they must give no token.
 */
describe("stream bodies", () => {
  const thread = SlackChat.thread({ team, channel, threadTs: "1794509110.999799" })
  const token = /<(?:@[UW][A-Z0-9]+|!subteam\^[A-Z0-9]+|!(?:here|channel|everyone))(?:\|[^<>]*)?>/g
  /** Slack's decoding on a stream, in code too, which is wider than Slack. */
  const decode = (text: string) =>
    text.replace(/&(?:lt|LT|#0*60|#[xX]0*3[cC]);/g, "<").replace(/&(?:commat|#0*64|#[xX]0*40);/g, "@").replace(
      /&(?:excl|#0*33|#[xX]0*21);/g,
      "!"
    )
  const tokens = (text: string) => decode(text).match(token) ?? []
  const alphabet = ["<", "&lt;", "&l", "t;", "&lt", "@U1", "&commat;", "!", "here", "`", "\n", "x", ">", "👍🏽"]
  const words = (length: number): Array<string> =>
    length === 0 ? [""] : words(length - 1).flatMap((word) => alphabet.map((piece) => word + piece))
  /** Whole tokens, which the generated words are too short to spell. */
  const seeds = [
    "<@U1>",
    "<!here>",
    "&lt;@U1>",
    "<&commat;U1>",
    "&#x3C;!here>",
    "`<@U1>`",
    "&#0000000000000060;@U1>",
    "&#x00000000003c;&#00000000064;U1>",
    "<@U1|hello world>",
    "&lt@U1> &#60@U1>"
  ]

  it.effect("hold the mention rule at every split, and leave no U+200B after the stream", () => {
    let count = 0
    // A new message for each stream, so the edit pacing never waits.
    const fake = makeFake({ "chat.startStream": () => ({ ok: true, channel, ts: `1.${count++}` }) })
    return Effect.gen(function*() {
      const native = (yield* adapter).nativeStream!
      let cleaned = 0
      for (const notify of [{}, { users: ["U1"] }] as ReadonlyArray<Escape.Notify>) {
        const allowed = (found: string) => notify.users !== undefined && /^<@U1[|>]/.test(found)
        for (const word of [...seeds, ...[1, 2].flatMap(words)]) {
          for (let at = 0; at <= word.length; at++) {
            for (const across of ["appends", "start"] as const) {
              const label = `${JSON.stringify(word)} at ${at} across ${across} ${JSON.stringify(notify)}`
              const before = fake.calls.length
              const first = word.slice(0, at)
              yield* Effect.gen(function*() {
                if (across === "start") {
                  const { id: ts } = yield* native.start(thread, { markdown: "s " + first, recipient: "U080YLYB277" })
                  yield* native.append(thread, ts, word.slice(at), { flush: true })
                  return yield* native.stop(thread, ts, { end: "done" })
                }
                const { id: ts } = yield* native.start(thread, { markdown: "s ", recipient: "U080YLYB277" })
                const { held } = yield* native.append(thread, ts, first, undefined)
                yield* native.append(thread, ts, first.slice(first.length - held) + word.slice(at), { flush: true })
                yield* native.stop(thread, ts, { end: "done" })
              }).pipe(SlackChat.withPostOptions({ notify }))
              const calls = fake.calls.slice(before)
              const streamed = calls.filter((call) => call.method !== "chat.update" && call.params.markdown_text)
                .map((call) => call.params.markdown_text).join("")
              if (across === "appends") {
                // Held text keeps every allowed token whole, and nothing else.
                assert.deepStrictEqual(tokens(streamed), tokens("s " + word).filter(allowed), label)
              } else {
                // The start holds nothing, so it may break an allowed token, but never makes one.
                assert.deepStrictEqual(tokens(streamed).filter((found) => !allowed(found)), [], label)
              }
              const update = calls.find((call) => call.method === "chat.update")
              const left = update === undefined ? streamed : update.params.blocks + update.params.text
              assert.notInclude(left, "\u200B", label)
              if (update !== undefined) cleaned++
            }
          }
        }
      }
      assert.isAbove(cleaned, 0)
    }).pipe(Effect.provide(slackLayer(fake)))
  }, 120_000)
})
