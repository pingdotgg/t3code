import * as SlackChat from "@effect/chat-slack/SlackChat"
import { SlackWebApi } from "@effect/chat-slack/SlackWebApi"
import { assert, describe, it } from "@effect/vitest"
import { checkMessage } from "effect/chat/ChatTest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import {
  adapter,
  authTest,
  botUserId,
  channel,
  checkOptions,
  fixture,
  hang,
  makeFake,
  slackLayer,
  team
} from "./utils.ts"

const root = "1794509110.999799"
const channelThread = SlackChat.thread({ team, channel })
const replyThread = SlackChat.thread({ team, channel, threadTs: root })

const run = <A, E>(
  fake: ReturnType<typeof makeFake>,
  effect: Effect.Effect<A, E, any>
) => effect.pipe(Effect.provide(slackLayer(fake))) as Effect.Effect<A, E>

const posted = (ts: string) => ({ ok: true, channel, ts })

const reason = <A>(effect: Effect.Effect<A, any>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => ({ op: error.op, tag: error.reason._tag, detail: error.reason.detail, retry: error.retry }))
  )

describe("post", () => {
  it.effect("sends a markdown block and an escaped text, with unfurls off", () => {
    const fake = makeFake({ "chat.postMessage": posted("1794509200.000100") })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        yield* slack.post(replyThread, { markdown: "hi <@U1> `<@U1>` & >" })
        assert.deepStrictEqual(fake.called("chat.postMessage")[0].params, {
          channel,
          thread_ts: root,
          blocks: JSON.stringify([{ type: "markdown", text: "hi &lt;@U1> `<@U1>` & >" }]),
          text: "hi &lt;@U1&gt; `&lt;@U1&gt;` &amp; &gt;",
          unfurl_links: "false",
          unfurl_media: "false"
        })
      })
    )
  })

  it.effect("withPostOptions allows a token and turns unfurls on", () => {
    const fake = makeFake({ "chat.postMessage": posted("1794509200.000101") })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        yield* slack.post(channelThread, { markdown: "hi <@U1> <@U2>" }).pipe(
          SlackChat.withPostOptions({ notify: { users: ["U1"] } }),
          SlackChat.withPostOptions({ unfurl: true })
        )
        const params = fake.called("chat.postMessage")[0].params
        assert.deepStrictEqual(JSON.parse(params.blocks), [{ type: "markdown", text: "hi <@U1> &lt;@U2>" }])
        assert.strictEqual(params.text, "hi <@U1> &lt;@U2&gt;")
        assert.strictEqual(params.unfurl_links, "true")
      })
    )
  })

  it.effect("never sends an empty text: a post or edit with no Markdown fails before the call", () => {
    const fake = makeFake({})
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        assert.deepStrictEqual(yield* reason(slack.post(channelThread, { markdown: "" })), {
          op: "post",
          tag: "InvalidRequest",
          detail: "no_text",
          retry: "denied"
        })
        assert.strictEqual((yield* reason(slack.edit(channelThread, "1.2", { markdown: "" }))).detail, "no_text")
        assert.strictEqual(fake.calls.length, 0)
      })
    )
  })

  it.effect("leaves the emoji count to Slack", () => {
    const fake = makeFake({
      "chat.postMessage": [posted("1794509200.000100"), { ok: false, error: "msg_blocks_too_long" }]
    })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        // 14,000 if `&lt;` cost 4, 11,000 as Slack counts it.
        yield* slack.post(channelThread, { markdown: "😀".repeat(1_000) + "<".repeat(1_000) })
        // 1,400 😀 are 14,000 with shortcodes: Slack refuses, nothing is posted.
        const failure = yield* reason(slack.post(channelThread, { markdown: "😀".repeat(1_400) }))
        assert.deepStrictEqual(failure, { op: "post", tag: "TooLarge", detail: "msg_blocks_too_long", retry: "denied" })
      })
    )
  })
})

describe("buttons and selects", () => {
  const button = { _tag: "Button", id: "go", label: "Go <!channel>", value: "v" } as const

  it.effect("with no Markdown, the text is the escaped labels", () => {
    const fake = makeFake({ "chat.postMessage": posted("1794509200.000100") })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        yield* slack.post(channelThread, { markdown: "", actions: [button] })
        assert.strictEqual(fake.called("chat.postMessage")[0].params.text, "Go &lt;!channel&gt;")
      })
    )
  })

  it.effect("an id holding the adapter's separator is refused before any call", () => {
    const fake = makeFake({})
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        const failure = yield* reason(
          slack.post(channelThread, { markdown: "x", actions: [{ ...button, id: "a\u241Fb" }] })
        )
        assert.deepStrictEqual([failure.tag, failure.detail], ["InvalidRequest", "invalid_action_id"])
        assert.deepStrictEqual(fake.calls, [])
      })
    )
  })
})

describe("files", () => {
  const upload = (ids: ReadonlyArray<string>) => {
    let next = 0
    return {
      "files.getUploadURLExternal": () => {
        const id = ids[next++]
        return { ok: true, upload_url: `https://files.slack.test/upload/${id}`, file_id: id }
      },
      "files.completeUploadExternal": { ok: true, files: ids.map((id) => ({ id })) }
    }
  }
  const file = (name: string) => ({ name, contentType: "text/plain", content: new TextEncoder().encode("hello") })
  const ts = "1794509300.000100"

  it.effect("uploads, completes with no channel, posts, then attaches with the same body", () => {
    const fake = makeFake({ ...upload(["F1", "F2"]), "chat.postMessage": posted(ts) })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        yield* slack.post(replyThread, { markdown: "a".repeat(5_000), files: [file("a.txt"), file("b.txt")] })
        assert.deepStrictEqual(
          fake.calls.map((call) => call.method).filter((method) => !method.startsWith("/upload/")),
          [
            "files.getUploadURLExternal",
            "files.getUploadURLExternal",
            "files.completeUploadExternal",
            "chat.postMessage",
            "chat.update"
          ]
        )
        assert.deepStrictEqual(fake.called("files.completeUploadExternal")[0].params, {
          files: JSON.stringify([{ id: "F1", title: "a.txt" }, { id: "F2", title: "b.txt" }])
        })
        const post = fake.called("chat.postMessage")[0].params
        assert.deepStrictEqual(fake.called("chat.update")[0].params, {
          channel,
          ts,
          blocks: post.blocks,
          text: post.text,
          file_ids: JSON.stringify(["F1", "F2"])
        })
        // The text is cut to the update budget from the post on.
        assert.isAtMost(new TextEncoder().encode(post.text).length, 3_800)
      })
    )
  })

  it.effect("a post with files and no Markdown carries the escaped file names", () => {
    const fake = makeFake({ ...upload(["F1", "F2"]), "chat.postMessage": posted(ts) })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        yield* slack.post(channelThread, { markdown: "", files: [file("*a*.txt"), file("<@U1>.csv")] })
        const post = fake.called("chat.postMessage")[0].params
        assert.deepStrictEqual(JSON.parse(post.blocks), [{ type: "markdown", text: "\\*a\\*.txt, &lt;@U1>.csv" }])
        assert.strictEqual(post.text, "*a*.txt, &lt;@U1&gt;.csv")
      })
    )
  })

  it.effect("a long Retry-After on the attach is cut off by its deadline and rolled back, even when interrupted", () => {
    const fake = makeFake({
      ...upload(["F1"]),
      "chat.postMessage": posted(ts),
      "chat.update": { status: 429, headers: { "retry-after": "3600" } }
    })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        const fiber = yield* Effect.forkChild(slack.post(channelThread, { markdown: "x", files: [file("a")] }))
        yield* TestClock.adjust("1 second")
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
        yield* TestClock.adjust("61 seconds")
        yield* Fiber.join(interrupting)
        assert.strictEqual(fake.called("chat.update").length, 1)
        assert.deepStrictEqual(fake.called("chat.delete")[0].params, { channel, ts })
        assert.deepStrictEqual(fake.called("files.delete").map((call) => call.params.file), ["F1"])
      })
    )
  })

  it.effect("a rollback that can't delete the message fails uncertain with SlackAttachFailed", () => {
    const fake = makeFake({
      ...upload(["F1", "F2"]),
      "chat.postMessage": posted(ts),
      "chat.update": { ok: false, error: "file_not_found" },
      "chat.delete": { ok: false, error: "cant_delete_message" }
    })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        const error = yield* Effect.flip(slack.post(replyThread, { markdown: "x", files: [file("a"), file("b")] }))
        assert.deepStrictEqual(
          [error.reason._tag, error.reason.detail, error.retry],
          ["Unknown", "attach_failed_message_left", "uncertain"]
        )
        const cause = error.reason.cause
        assert.instanceOf(cause, SlackChat.SlackAttachFailed)
        assert.deepStrictEqual(cause.thread, replyThread)
        assert.strictEqual(cause.messageId, ts)
        assert.deepStrictEqual(cause.fileIds, ["F1", "F2"])
        // The files are kept, so the ids it carries still mean something.
        assert.strictEqual(fake.called("files.delete").length, 0)
      })
    )
  })
})

describe("errors", () => {
  it.effect("maps Slack's answers, and never repeats a write that may have landed", () => {
    const fake = makeFake({
      "chat.update": { ok: false, error: "invalid_auth" },
      "chat.postMessage": { status: 500 },
      "conversations.info": { status: 429, headers: { "retry-after": "7" } }
    })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        assert.deepStrictEqual(yield* reason(slack.edit(channelThread, "1.2", { markdown: "x" })), {
          op: "edit",
          tag: "Unauthenticated",
          detail: "invalid_auth",
          retry: "denied"
        })
        assert.deepStrictEqual(yield* reason(slack.post(channelThread, { markdown: "x" })), {
          op: "post",
          tag: "PlatformUnavailable",
          detail: "http_500",
          retry: "uncertain"
        })
        assert.strictEqual(fake.called("chat.postMessage").length, 1)
        const api = yield* SlackWebApi
        const limited = yield* Effect.flip(api.call("conversations.info", { channel }, { retry: false }))
        assert.strictEqual(limited.reason._tag, "RateLimited")
        assert.deepStrictEqual(limited.retryAfter, Duration.seconds(7))
      })
    )
  })
})

describe("reads", () => {
  it.effect("fetchMessage normalises what Slack stored", () => {
    const replies = fixture("markdown-mentions").calls.find((call) => call.method === "conversations.replies")!
      .response
    const fake = makeFake({ "auth.test": authTest, "conversations.replies": replies })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        const message = yield* slack.fetchMessage(channelThread, "1794509003.143939")
        yield* checkMessage(message, checkOptions)
        assert.strictEqual(message.mentions.length, 2)
        // The thread's channel, with both bounds at the message, inclusive, or Slack leaves the message out.
        const { channel: requested, inclusive, latest, oldest } = fake.called("conversations.replies")[0].params
        assert.deepStrictEqual({ channel: requested, latest, oldest, inclusive }, {
          channel,
          latest: "1794509003.143939",
          oldest: "1794509003.143939",
          inclusive: "true"
        })
      })
    )
  })

  it.effect("thread history pages in both directions, from exclusive", () => {
    const message = (ts: string) => ({ ts, thread_ts: root, user: "U080YLYB277", text: ts })
    const fake = makeFake({
      "auth.test": authTest,
      "conversations.replies": [
        {
          ok: true,
          messages: [message(root), message("1794509111.000001")],
          response_metadata: { next_cursor: "page2" }
        },
        { ok: true, messages: [message(root), message("1794509112.000001"), message("1794509113.000001")] }
      ]
    })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        const forward = yield* Stream.runCollect(slack.history(replyThread, { direction: "forward" }))
        assert.deepStrictEqual(forward.map((m) => m.id), [
          root,
          "1794509111.000001",
          "1794509112.000001",
          "1794509113.000001"
        ])
        const backward = yield* Stream.runCollect(
          slack.history(replyThread, { direction: "backward", from: "1794509113.000001" })
        )
        assert.deepStrictEqual(backward.map((m) => m.id), ["1794509112.000001", root])
      })
    )
  })

  it.effect("getThread", () => {
    const fake = makeFake({
      "conversations.info": {
        ok: true,
        channel: { id: channel, name: "chat-testing-123", created: 1794400000, topic: { value: "tests" } }
      }
    })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        const info = yield* slack.getThread(channelThread)
        assert.deepStrictEqual([info.kind, info.name, info.topic], ["channel", "chat-testing-123", "tests"])
        const thread = yield* slack.getThread(replyThread)
        assert.strictEqual(thread.kind, "thread")
        assert.deepStrictEqual(thread.parent, channelThread)
      })
    )
  })
})

describe("delete", () => {
  it.effect("stops an open stream first", () => {
    const fake = makeFake({
      "chat.delete": [{ ok: false, error: "cant_delete_message" }, { ok: true }],
      "chat.stopStream": { ok: true }
    })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        yield* slack.delete(replyThread, "1794509111.134189")
        assert.deepStrictEqual(fake.calls.map((call) => call.method), ["chat.delete", "chat.stopStream", "chat.delete"])
      })
    )
  })
})

describe("nativeStream", () => {
  const ts = "1794509111.134189"

  it.effect("is unsupported off a thread, without a recipient, or when turned off", () =>
    run(
      makeFake({}),
      Effect.gen(function*() {
        const native = (yield* adapter).nativeStream!
        const cases = [
          native.start(channelThread, { markdown: "x", recipient: "U1" }),
          native.start(replyThread, { markdown: "x" }),
          native.start(replyThread, { markdown: "x", recipient: "U1" }).pipe(
            SlackChat.withPostOptions({ nativeStream: false })
          )
        ]
        for (const start of cases) assert.strictEqual((yield* reason(start)).tag, "Unsupported")
      })
    ))

  it.effect("closed, too large and stopped", () => {
    const fake = makeFake({
      "chat.startStream": posted(ts),
      "chat.appendStream": [
        { ok: false, error: "message_not_in_streaming_state" },
        { ok: false, error: "stopped_by_user" }
      ],
      "agents.sessions.setStatus": { ok: true }
    })
    return run(
      fake,
      Effect.gen(function*() {
        const native = (yield* adapter).nativeStream!
        yield* native.start(replyThread, { markdown: "a".repeat(11_990), recipient: "U1" })
        assert.strictEqual(
          (yield* reason(native.append(replyThread, ts, "b".repeat(11), { flush: true }))).tag,
          "TooLarge"
        )
        assert.strictEqual(fake.called("chat.appendStream").length, 0)
        assert.deepStrictEqual(yield* native.append(replyThread, ts, "c", { flush: true }), {
          state: "closed",
          held: 0
        })
        const suspended = SlackChat.withPostOptions({ sessionStatusAtEnd: "suspended" })
        assert.deepStrictEqual(yield* native.append(replyThread, ts, "d", { flush: true }).pipe(suspended), {
          state: "stopped",
          held: 0
        })
        // The layer sends no stop after a stopped append, so the append moves the session off processing.
        assert.deepStrictEqual(fake.called("agents.sessions.setStatus").map((call) => call.params), [{
          channel_id: channel,
          thread_ts: root,
          status: "suspended"
        }])
      })
    )
  })

  it.effect("rotates with processing, and stops asking once Slack says not_authorized", () => {
    const fake = makeFake({
      "chat.stopStream": (params) =>
        params.session_status !== undefined
          ? { ok: false, error: "not_authorized" }
          : { ok: true, message: { ts, ai_context: { result_status: "stopped_by_user" } } },
      "agents.sessions.setStatus": { ok: false, error: "not_authorized" }
    })
    return run(
      fake,
      Effect.gen(function*() {
        const native = (yield* adapter).nativeStream!
        assert.deepStrictEqual(yield* native.stop(replyThread, ts, { end: "rotating" }), { stopped: true })
        assert.deepStrictEqual(
          fake.called("chat.stopStream").map((call) => call.params.session_status),
          ["processing", undefined]
        )
        // Not a declared agent: no more session status, and a reply never fails over it.
        assert.deepStrictEqual(yield* native.stop(replyThread, ts, { end: "done" }), { stopped: true })
        assert.strictEqual(fake.called("chat.stopStream").length, 3)
        assert.isUndefined(fake.called("chat.stopStream")[2].params.session_status)
        assert.strictEqual(fake.called("agents.sessions.setStatus").length, 0)
      })
    )
  })

  it.effect("after a 429 the reply's next part waits, then doubles its interval, and another reply does not", () => {
    const next = "1794509201.000100"
    const other = "1794509202.000100"
    const fake = makeFake({
      "chat.appendStream": [{ status: 429, headers: { "retry-after": "3" } }, posted(other), posted(next)],
      "chat.stopStream": { ok: true, message: { ts } },
      "chat.startStream": [posted(other), posted(next)]
    })
    return run(
      fake,
      Effect.gen(function*() {
        const native = (yield* adapter).nativeStream!
        const recipient = "U080YLYB277"
        assert.strictEqual((yield* reason(native.append(replyThread, ts, "a", { flush: true }))).tag, "RateLimited")
        yield* native.stop(replyThread, ts, { end: "rotating" })
        // Another reply in the thread starts and appends at once.
        yield* native.start(replyThread, { markdown: "x", recipient })
        assert.deepStrictEqual(fake.called("chat.startStream")[0].params, {
          channel,
          thread_ts: root,
          recipient_user_id: recipient,
          recipient_team_id: team,
          markdown_text: "x"
        })
        yield* native.append(replyThread, other, "y", { flush: true })
        assert.strictEqual(fake.called("chat.appendStream").length, 2)
        // The reply's next part waits for the retry-after.
        const start = yield* Effect.forkChild(native.start(replyThread, { markdown: "b", recipient, continues: ts }))
        yield* TestClock.adjust("2999 millis")
        assert.strictEqual(fake.called("chat.startStream").length, 1)
        yield* TestClock.adjust("1 millis")
        assert.strictEqual((yield* Fiber.join(start)).id, next)
        // Its appends keep the doubled interval, two seconds.
        const append = yield* Effect.forkChild(native.append(replyThread, next, "c", { flush: true }))
        yield* TestClock.adjust("1999 millis")
        assert.strictEqual(fake.called("chat.appendStream").length, 2)
        yield* TestClock.adjust("1 millis")
        yield* Fiber.join(append)
        assert.strictEqual(fake.called("chat.appendStream").length, 3)
      })
    )
  })

  it.effect("an edit retried after a 429 keeps the doubled interval", () => {
    const fake = makeFake({
      "chat.update": [{ status: 429, headers: { "retry-after": "1" } }, { ok: true }, { ok: true }]
    })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        const first = yield* Effect.forkChild(slack.edit(replyThread, ts, { markdown: "a" }))
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(first)
        assert.strictEqual(fake.called("chat.update").length, 2)
        // Six seconds, twice the three second floor.
        const second = yield* Effect.forkChild(slack.edit(replyThread, ts, { markdown: "ab" }))
        yield* TestClock.adjust("5999 millis")
        assert.strictEqual(fake.called("chat.update").length, 2)
        yield* TestClock.adjust("1 millis")
        yield* Fiber.join(second)
        assert.strictEqual(fake.called("chat.update").length, 3)
      })
    )
  })

  it.effect("edits to one message are three seconds apart", () => {
    const other = "1794509200.000200"
    const fake = makeFake({ "chat.update": { ok: true } })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* adapter
        yield* slack.edit(replyThread, ts, { markdown: "a" })
        const second = yield* Effect.forkChild(slack.edit(replyThread, ts, { markdown: "ab" }))
        // Another message is not held back.
        yield* slack.edit(replyThread, other, { markdown: "x" })
        yield* TestClock.adjust("2999 millis")
        assert.strictEqual(fake.called("chat.update").length, 2)
        yield* TestClock.adjust("1 millis")
        yield* Fiber.join(second)
        assert.strictEqual(fake.called("chat.update").length, 3)
      })
    )
  })

  describe("the cleanup edit", () => {
    const z = "\u200B"
    const recipient = "U080YLYB277"

    it.effect("rewrites a stream whose appends differ from the block, once, after the stop, with no actions", () => {
      const fake = makeFake({ "chat.startStream": posted(ts), "chat.appendStream": posted(ts) })
      return run(
        fake,
        Effect.gen(function*() {
          const native = (yield* adapter).nativeStream!
          yield* native.start(replyThread, { markdown: "Hi <@U2> ", recipient })
          yield* native.append(replyThread, ts, "and `<@U3>` a < b", { flush: true })
          assert.strictEqual(fake.called("chat.startStream")[0].params.markdown_text, `Hi <${z}@U2> `)
          assert.strictEqual(fake.called("chat.appendStream")[0].params.markdown_text, `and \`<${z}@U3>\` a &lt; b`)
          yield* native.stop(replyThread, ts, { end: "done" })
          assert.deepStrictEqual(fake.calls.map((call) => call.method).slice(-2), ["chat.stopStream", "chat.update"])
          assert.deepStrictEqual(
            fake.called("chat.update").map((call): Record<string, unknown> => ({
              ...call.params,
              blocks: JSON.parse(call.params.blocks)
            })),
            [{
              channel,
              ts,
              blocks: [{ type: "markdown", text: "Hi &lt;@U2> and `<@U3>` a &lt; b" }],
              text: "Hi &lt;@U2&gt; and `&lt;@U3&gt;` a &lt; b"
            }]
          )
        })
      )
    })

    it.effect("runs again on a stop sent after one interrupted during it", () => {
      const fake = makeFake({
        "chat.startStream": posted(ts),
        "chat.stopStream": [{ ok: true, result_status: "stopped_by_user" }, {
          ok: false,
          error: "message_not_in_streaming_state"
        }],
        "chat.update": [hang, posted(ts)],
        "agents.sessions.setStatus": { ok: true }
      })
      return run(
        fake,
        Effect.gen(function*() {
          const native = (yield* adapter).nativeStream!
          yield* native.start(replyThread, { markdown: "<@U2>", recipient })
          const first = yield* Effect.forkChild(native.stop(replyThread, ts, { end: "done" }))
          yield* TestClock.adjust("1 millis")
          assert.strictEqual(fake.called("chat.update").length, 1)
          yield* Fiber.interrupt(first)
          // Slack answers this one as not streaming, so the user's stop is known from the first.
          assert.deepStrictEqual(yield* native.stop(replyThread, ts, { end: "done" }), { stopped: true })
          assert.strictEqual(fake.called("chat.update").length, 2)
          assert.strictEqual(fake.called("agents.sessions.setStatus").length, 1)
        })
      )
    })

    it.effect("runs when an append finds the stream stopped by the user, and only once", () => {
      const fake = makeFake({
        "chat.startStream": posted(ts),
        "chat.appendStream": { ok: false, error: "stopped_by_user" },
        "chat.stopStream": { ok: false, error: "message_not_in_streaming_state" }
      })
      return run(
        fake,
        Effect.gen(function*() {
          const native = (yield* adapter).nativeStream!
          yield* native.start(replyThread, { markdown: "a <@U2>", recipient })
          yield* native.append(replyThread, ts, " b", { flush: true })
          assert.deepStrictEqual(fake.called("chat.update").map((call) => JSON.parse(call.params.blocks)), [
            [{ type: "markdown", text: "a &lt;@U2>" }]
          ])
          assert.deepStrictEqual(yield* native.stop(replyThread, ts, { end: "done" }), { stopped: true })
          assert.strictEqual(fake.called("chat.update").length, 1)
        })
      )
    })

    it.effect("runs, with the session status, on the stops after that append is cut off", () => {
      const fake = makeFake({
        "chat.startStream": posted(ts),
        "chat.appendStream": { ok: false, error: "stopped_by_user" },
        "chat.stopStream": { ok: false, error: "message_not_in_streaming_state" },
        "chat.update": [hang, posted(ts)],
        "agents.sessions.setStatus": [hang, { ok: true }]
      })
      return run(
        fake,
        Effect.gen(function*() {
          const native = (yield* adapter).nativeStream!
          yield* native.start(replyThread, { markdown: "a <@U2>", recipient })
          // Cut off during the cleanup.
          const appended = yield* Effect.forkChild(native.append(replyThread, ts, " b", { flush: true }))
          yield* TestClock.adjust("1 millis")
          yield* Fiber.interrupt(appended)
          assert.strictEqual(fake.called("chat.update").length, 1)
          assert.strictEqual(fake.called("agents.sessions.setStatus").length, 0)
          // The finaliser's stop, cut off during the session status.
          const stopping = yield* Effect.forkChild(native.stop(replyThread, ts, { end: "done" }))
          yield* TestClock.adjust("1 millis")
          yield* Fiber.interrupt(stopping)
          assert.strictEqual(fake.called("chat.update").length, 2)
          assert.strictEqual(fake.called("agents.sessions.setStatus").length, 1)
          assert.deepStrictEqual(yield* native.stop(replyThread, ts, { end: "done" }), { stopped: true })
          assert.deepStrictEqual(fake.called("agents.sessions.setStatus").map((call) => call.params), [
            { channel_id: channel, thread_ts: root, status: "active" },
            { channel_id: channel, thread_ts: root, status: "active" }
          ])
          // A stop sent again sets it no third time.
          yield* native.stop(replyThread, ts, { end: "done" })
          assert.strictEqual(fake.called("agents.sessions.setStatus").length, 2)
          assert.strictEqual(fake.called("chat.update").length, 2)
        })
      )
    })
  })

  it.effect("holds a trailing high surrogate and sends any other lone surrogate as U+FFFD", () => {
    const fake = makeFake({ "chat.startStream": posted(ts), "chat.appendStream": posted(ts) })
    return run(
      fake,
      Effect.gen(function*() {
        const native = (yield* adapter).nativeStream!
        yield* native.start(replyThread, { markdown: "x\udc00", recipient: "U1" })
        assert.deepStrictEqual(yield* native.append(replyThread, ts, "a\ud83d", undefined), { state: "open", held: 1 })
        assert.deepStrictEqual(yield* native.append(replyThread, ts, "\ud83d", undefined), { state: "open", held: 1 })
        // With an unclosed < as well, the longer tail.
        assert.deepStrictEqual(yield* native.append(replyThread, ts, "\ud83d\ude00 <\ud83d", undefined), {
          state: "open",
          held: 2
        })
        assert.deepStrictEqual(yield* native.append(replyThread, ts, "<\ud83d", { flush: true }), {
          state: "open",
          held: 0
        })
        assert.strictEqual(fake.called("chat.startStream")[0].params.markdown_text, "x\ufffd")
        assert.deepStrictEqual(
          fake.called("chat.appendStream").map((call) => call.params.markdown_text),
          ["a", "😀 ", "&lt;\ufffd"]
        )
      })
    )
  })
})

describe("SlackChat", () => {
  it.effect("botUserId and user", () => {
    const fake = makeFake({
      "auth.test": authTest,
      "users.info": {
        ok: true,
        user: {
          id: "U0EXT",
          team_id: "T0OTHER",
          name: "ext",
          is_restricted: true,
          is_stranger: true,
          profile: { display_name: "Ext" }
        }
      }
    })
    return run(
      fake,
      Effect.gen(function*() {
        const slack = yield* SlackChat.SlackChat
        assert.strictEqual(yield* slack.botUserId, botUserId)
        const user = yield* slack.user("U0EXT")
        assert.include(user, { id: "U0EXT", teamId: "T0OTHER", name: "Ext", isRestricted: true, isStranger: true })
      })
    )
  })

  it("emoji in both directions", () => {
    assert.deepStrictEqual(SlackChat.emojiFromName(":+1::skin-tone-3:"), Option.some("👍🏼"))
    assert.deepStrictEqual(SlackChat.emojiToName("👍"), Option.some("+1"))
    assert.deepStrictEqual(SlackChat.emojiToName("❤"), Option.some("heart"))
    assert.isTrue(Option.isNone(SlackChat.emojiFromName("party-parrot")))
  })
})
