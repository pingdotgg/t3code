import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Schema } from "effect"
import { ChatError } from "effect/chat"

const cause = new Error("https://example.com/files/secret.txt")

const reasons: ReadonlyArray<ChatError.ChatErrorReason> = [
  new ChatError.RateLimited({ retryAfter: Duration.seconds(3), detail: "ratelimited", cause }),
  new ChatError.Unsupported({ capability: "edit", detail: "no_edit", cause }),
  new ChatError.Transport({ retry: "uncertain", detail: "timeout", cause }),
  new ChatError.PlatformUnavailable({ retry: "retry", detail: "503", cause }),
  new ChatError.NoAdapter({ detail: "none", cause }),
  new ChatError.Unauthenticated({ detail: "invalid_auth", cause }),
  new ChatError.Forbidden({ detail: "not_in_channel", cause }),
  new ChatError.NotFound({ detail: "channel_not_found", cause }),
  new ChatError.TooLarge({ detail: "msg_too_long", cause }),
  new ChatError.InvalidRequest({ detail: "invalid_blocks", cause }),
  new ChatError.InvalidResponse({ detail: "bad_json", cause }),
  new ChatError.Unknown({ detail: "unknown", cause })
]

describe("ChatError", () => {
  it("fixes the retry value per reason", () => {
    assert.deepStrictEqual(
      reasons.map((reason) => reason.retry),
      [
        "retry",
        "denied",
        "uncertain",
        "retry",
        "denied",
        "denied",
        "denied",
        "denied",
        "denied",
        "denied",
        "denied",
        "uncertain"
      ]
    )
  })

  it.effect("round-trips every reason through its Schema, cause included", () =>
    Effect.gen(function*() {
      const codec = Schema.toCodecJson(ChatError.ChatError)
      for (const reason of reasons) {
        const error = new ChatError.ChatError({ platform: "slack", op: "post", reason })
        const decoded = yield* Schema.decodeEffect(codec)(yield* Schema.encodeEffect(codec)(error))
        assert.strictEqual(decoded.reason._tag, reason._tag)
        assert.strictEqual(decoded.reason.detail, reason.detail)
        assert.strictEqual(decoded.retry, error.retry)
        assert.instanceOf(decoded.reason.cause, Error)
        assert.strictEqual((decoded.reason.cause as Error).message, cause.message)
      }
    }))

  it("leaves cause out of toJSON and message", () => {
    for (const reason of reasons) {
      const error = new ChatError.ChatError({ platform: "slack", op: "post", reason })
      assert.notInclude(JSON.stringify(error), "secret")
      assert.notInclude(JSON.stringify(reason), "secret")
      assert.notInclude(error.message, "secret")
    }
  })

  it("delegates retryAfter to the reason", () => {
    const error = new ChatError.ChatError({ platform: "slack", op: "post", reason: reasons[0] })
    assert.deepStrictEqual(error.retryAfter, Duration.seconds(3))
  })
})
