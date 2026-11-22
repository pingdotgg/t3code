import * as Envelope from "@effect/chat-teams/internal/envelope"
import { assert, describe, it } from "@effect/vitest"
import type * as ChatUi from "effect/chat/ChatUi"
import { Digest, Mac, SecureRandom } from "effect/crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"

const layer = Layer.mergeAll(Digest.layerWebCrypto, Mac.layerWebCrypto).pipe(
  Layer.provideMerge(SecureRandom.layerWebCrypto)
)

const k1 = Redacted.make({ kty: "oct", kid: "k1", k: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc" } as const)
const k2 = Redacted.make({ kty: "oct", kid: "k2", k: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg" } as const)

const options = { appId: "app-1", tenantId: "tenant-1" }
const conversation = "19:abc@thread.tacv2"

describe("envelope", () => {
  it.effect("refuses a button from another conversation, a tampered token and an unknown kid", () =>
    Effect.gen(function*() {
      const envelope = yield* Envelope.make({ ...options, keys: [k1] })
      const token = yield* envelope.signButton(conversation, { id: "approve", value: "42" })
      assert.isTrue(Option.isNone(yield* envelope.verifyButton(token, { conversationId: "19:other@thread.tacv2" })))

      const [header, payload, signature] = token.split(".")
      const tampered = `${header}.${payload}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BA" : "AA"}`
      assert.isTrue(Option.isNone(yield* envelope.verifyButton(tampered, { conversationId: conversation })))

      const other = yield* Envelope.make({ ...options, keys: [k2] })
      const unknownKid = yield* other.signButton(conversation, { id: "approve" })
      assert.isTrue(Option.isNone(yield* envelope.verifyButton(unknownKid, { conversationId: conversation })))

      const rotated = yield* Envelope.make({ ...options, keys: [k2, k1] })
      assert.deepStrictEqual(
        yield* rotated.verifyButton(token, { conversationId: conversation }),
        Option.some({ id: "approve", value: "42" })
      )
    }).pipe(Effect.provide(layer)))

  it.effect("binds a dialog to its user and reply chain, and a submit to its definition", () =>
    Effect.gen(function*() {
      const envelope = yield* Envelope.make({ ...options, keys: [k1] })
      const modal: ChatUi.Modal = {
        _tag: "Modal",
        id: "deploy",
        title: "Deploy",
        metadata: "m",
        elements: [
          { _tag: "SelectInput", id: "env", label: "Env", options: [{ label: "Prod", value: "prod" }] },
          { _tag: "TextInput", id: "note", label: "Note", optional: true }
        ]
      }
      const opened = `${conversation};messageid=123`
      const token = yield* envelope.signDialog({ conversationId: opened, userId: "u1", messageId: "123", modal })
      assert.isTrue(Option.isNone(yield* envelope.verifyDialog(token, { conversationId: opened, userId: "u2" })))
      // The same channel, another reply chain: refused, so a submit keeps the click's origin.
      const moved = `${conversation};messageid=456`
      assert.isTrue(Option.isNone(yield* envelope.verifyDialog(token, { conversationId: moved, userId: "u1" })))
      const verified = yield* envelope.verifyDialog(token, { conversationId: opened, userId: "u1" })
      assert.deepStrictEqual(verified, Option.some({ conversationId: opened, messageId: "123", modal }))
      assert.deepStrictEqual(
        Envelope.validateSubmission(modal, { effect: token, env: "prod", note: "" }),
        Option.some({ env: "prod" })
      )
      assert.isTrue(Option.isNone(Envelope.validateSubmission(modal, { env: "staging" })))
    }).pipe(Effect.provide(layer)))
})
