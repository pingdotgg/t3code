/**
 * The envelope a button or dialog carries in its `effect` data key: a compact
 * HS256 JWT bound to the bot, the tenant and the conversation. A dialog token
 * also binds the user it opened for and holds the modal's definition, so a
 * submit is checked against what was signed.
 */
import type { NonEmptyReadonlyArray } from "effect/Array"
import type { ChatErrorReason } from "effect/chat/ChatError"
import type * as ChatUi from "effect/chat/ChatUi"
import * as Clock from "effect/Clock"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Base64Url from "effect/encoding/Base64Url"
import * as Jwk from "effect/jose/Jwk"
import * as Jwt from "effect/jose/Jwt"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { baseConversation, maxIdLength } from "./address.ts"
import { invalidRequest, tooLarge } from "./errors.ts"

/** The data key that holds the token. A modal field may not use it. @internal */
export const reservedKey = "effect"

/**
 * Bounds on what a token holds, in UTF-16 code units. `definition` bounds the
 * UTF-8 bytes of a modal's JSON without its metadata.
 *
 * @internal
 */
export const limits = {
  id: maxIdLength,
  kid: 16,
  buttonValue: 2_000,
  metadata: 2_800,
  text: 4_000,
  fields: 100,
  options: 100,
  definition: 16_000
} as const

/** The default max length of a text input. @internal */
export const defaultMaxLength = limits.text

/** How long a dialog token is good for when the caller gives no ttl. @internal */
export const defaultDialogTtl = Duration.hours(1)

const typ = { button: "teams-button", dialog: "teams-dialog" } as const

// Schemas

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max))
const Id = bounded(limits.id)
const Text = bounded(limits.text)
const Hash = Schema.String.check(Schema.isBetweenLength(43, 43))
const Length = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: limits.text }))

const SelectOption = Schema.Struct({ label: Text, value: Text })
const Options = Schema.Array(SelectOption).check(Schema.isMaxLength(limits.options))

const Definition = Schema.TaggedStruct("Modal", {
  id: Id,
  title: Text,
  submitLabel: Schema.optionalKey(Text),
  elements: Schema.Array(Schema.Union([
    Schema.TaggedStruct("TextInput", {
      id: Id,
      label: Text,
      multiline: Schema.optionalKey(Schema.Boolean),
      placeholder: Schema.optionalKey(Text),
      initial: Schema.optionalKey(Text),
      optional: Schema.optionalKey(Schema.Boolean),
      minLength: Schema.optionalKey(Length),
      maxLength: Schema.optionalKey(Length)
    }),
    Schema.TaggedStruct("SelectInput", {
      id: Id,
      label: Text,
      placeholder: Schema.optionalKey(Text),
      options: Options,
      initial: Schema.optionalKey(Text),
      optional: Schema.optionalKey(Schema.Boolean)
    }),
    Schema.TaggedStruct("Text", { text: Text })
  ])).check(Schema.isMaxLength(limits.fields))
})

const ButtonClaims = Schema.Struct({
  aud: Id,
  tid: Id,
  cnv: Hash,
  id: Id,
  val: Schema.optionalKey(bounded(limits.buttonValue))
})

const DialogClaims = Schema.Struct({
  aud: Id,
  tid: Id,
  cnv: Hash,
  cid: Id,
  sub: Id,
  exp: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  mid: Schema.optionalKey(Id),
  def: Definition,
  md: Schema.optionalKey(bounded(limits.metadata))
})

// Lengths

const encoder = new TextEncoder()
const utf8Length = (text: string): number => encoder.encode(text).length
const base64Length = (bytes: number): number => Math.ceil(bytes * 4 / 3)
/** A string of `n` code units is at most 6 bytes each in JSON, plus quotes. */
const jsonString = (n: number): number => 6 * n + 2
/** An HS256 signature is 32 bytes. */
const signatureLength = base64Length(32)
/** The conversation hash: base64url of a SHA-256 digest. */
const hashLength = base64Length(32)

const headerJson = (kid: string, type: string): string => JSON.stringify({ alg: "HS256", kid, typ: type })

/**
 * The longest token `signButton` or `signDialog` can produce. A longer value
 * is refused before it is parsed.
 *
 * @internal
 */
export const maxTokenLength: number = (() => {
  const header = utf8Length(headerJson("", typ.dialog)) + limits.kid
  const button = utf8Length(JSON.stringify({ aud: "", tid: "", cnv: "", id: "", val: "" })) - 2 * 5 +
    3 * jsonString(limits.id) + jsonString(hashLength) + jsonString(limits.buttonValue)
  const dialog =
    utf8Length(JSON.stringify({ aud: "", tid: "", cnv: "", cid: "", sub: "", exp: 0, mid: "", def: 0, md: "" })) -
    2 * 7 - 2 + 5 * jsonString(limits.id) + jsonString(hashLength) + String(Number.MAX_SAFE_INTEGER).length +
    limits.definition + jsonString(limits.metadata)
  return base64Length(header) + 1 + base64Length(Math.max(button, dialog)) + 1 + signatureLength
})()

/** @internal */
export interface ButtonContext {
  readonly appId: string
  readonly tenantId: string
  /** The kid of the signing key. */
  readonly kid: string
}

const buttonClaims = (
  context: Omit<ButtonContext, "kid">,
  cnv: string,
  button: { readonly id: string; readonly value?: string | undefined }
): typeof ButtonClaims.Type => ({
  aud: context.appId,
  tid: context.tenantId,
  cnv,
  id: button.id,
  ...(button.value === undefined ? {} : { val: button.value })
})

/**
 * The exact length of the token `signButton` produces for `button`, without
 * signing it. The header and claims are deterministic JSON and the hash and
 * signature have fixed lengths.
 *
 * @internal
 */
export const buttonTokenLength = (
  context: ButtonContext,
  button: { readonly id: string; readonly value?: string | undefined }
): number =>
  base64Length(utf8Length(headerJson(context.kid, typ.button))) + 1 +
  base64Length(utf8Length(JSON.stringify(buttonClaims(context, "x".repeat(hashLength), button)))) + 1 +
  signatureLength

// Checks

/** Whether a field of `modal` uses the reserved `effect` id. @internal */
export const hasReservedField = (modal: ChatUi.Modal): boolean =>
  modal.elements.some((element) => element._tag !== "Text" && element.id === reservedKey)

const definitionOf = (modal: ChatUi.Modal): typeof Definition.Type => {
  const { metadata: _, ...definition } = modal
  return definition
}

const isDefinition = Schema.is(Definition)

/**
 * Why `modal` cannot go in a dialog token, if it can't: a field with the
 * reserved id, or more than the limits allow.
 *
 * @internal
 */
export const checkModal = (modal: ChatUi.Modal): ChatErrorReason | undefined => {
  if (hasReservedField(modal)) return invalidRequest("reserved_field_id")
  if (modal.metadata !== undefined && modal.metadata.length > limits.metadata) {
    return tooLarge(undefined, "modal_metadata_too_long")
  }
  const definition = definitionOf(modal)
  if (!isDefinition(definition) || utf8Length(JSON.stringify(definition)) > limits.definition) {
    return tooLarge(undefined, "modal_too_large")
  }
  return undefined
}

/** Why `button` cannot go in a button token, if it can't. @internal */
export const checkButton = (
  button: { readonly id: string; readonly value?: string | undefined }
): ChatErrorReason | undefined =>
  button.id.length > limits.id
    ? tooLarge(undefined, "action_id_too_long")
    : button.value !== undefined && button.value.length > limits.buttonValue
    ? tooLarge(undefined, "action_data_too_long")
    : undefined

/**
 * The values of a dialog submit, checked against the signed definition, or
 * nothing when they don't match it.
 *
 * - Keys are the ids of the inputs. The reserved `effect` key is skipped.
 * - Every value is a string. An optional input left empty has no key.
 * - A text input is held to its `minLength` and `maxLength` (default 4,000),
 *   and a select to its options.
 *
 * @internal
 */
export const validateSubmission = (
  definition: ChatUi.Modal,
  values: unknown
): Option.Option<Record<string, string>> => {
  if (!Predicate.isObject(values)) return Option.none()
  const input = values
  const fields = new Map<string, ChatUi.TextInput | ChatUi.SelectInput>()
  for (const element of definition.elements) {
    if (element._tag !== "Text") fields.set(element.id, element)
  }
  for (const key of Object.keys(input)) {
    if (key !== reservedKey && !fields.has(key)) return Option.none()
  }
  const out: Record<string, string> = {}
  for (const [id, field] of fields) {
    const value = Object.hasOwn(input, id) ? input[id] : undefined
    if (value !== undefined && typeof value !== "string") return Option.none()
    if (value === undefined || value === "") {
      if (field.optional === true) continue
      return Option.none()
    }
    if (field._tag === "TextInput") {
      if (value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? defaultMaxLength)) {
        return Option.none()
      }
    } else if (!field.options.some((option) => option.value === value)) {
      return Option.none()
    }
    Object.defineProperty(out, id, { value, enumerable: true, writable: true, configurable: true })
  }
  return Option.some(out)
}

// Envelope

/** @internal */
export interface Button {
  readonly id: string
  readonly value?: string | undefined
}

/** @internal */
export interface Dialog {
  /**
   * The conversation id the click came from, as Teams sent it. A submit
   * must come from the same one.
   */
  readonly conversationId: string
  /** The message the click came from. Absent when a command opened it. */
  readonly messageId?: string | undefined
  readonly modal: ChatUi.Modal
}

/** @internal */
export interface Envelope {
  /** Fails with the reason `button` is over the limits. */
  readonly signButton: (conversationId: string, button: Button) => Effect.Effect<string, ChatErrorReason>
  /** The button the token was signed for, if it was signed for this conversation. */
  readonly verifyButton: (
    token: unknown,
    activity: { readonly conversationId: string }
  ) => Effect.Effect<Option.Option<Button>>
  /** Fails with the reason the modal or an id is refused. */
  readonly signDialog: (
    dialog: Dialog & { readonly userId: string; readonly ttl?: Duration.Input | undefined }
  ) => Effect.Effect<string, ChatErrorReason>
  /**
   * The dialog the token was signed for, if it is unexpired, for this user,
   * and from exactly this conversation id.
   */
  readonly verifyDialog: (
    token: unknown,
    activity: { readonly conversationId: string; readonly userId: string }
  ) => Effect.Effect<Option.Option<Dialog>>
  /** `buttonTokenLength` with this envelope's app, tenant and signing key. */
  readonly tokenLength: (button: Button) => number
}

const validKid = /^[A-Za-z0-9_-]{1,16}$/

/**
 * Builds the envelope. The first key signs, and a token is verified with the
 * key its `kid` names. A key without a valid `kid`, a repeated `kid` or
 * a key under 32 bytes is a defect.
 *
 * @internal
 */
export const make = Effect.fnUntraced(function*(options: {
  readonly appId: string
  readonly tenantId: string
  readonly keys: NonEmptyReadonlyArray<Redacted.Redacted<Jwk.SecretJwk>>
}): Effect.fn.Return<Envelope, never, Mac.Mac | Digest.Digest> {
  const keys = new Map<string, Jwk.SecretKey<"HS256">>()
  for (const input of options.keys) {
    const kid = Redacted.value(input).kid
    if (kid === undefined || !validKid.test(kid)) {
      return yield* Effect.die(new Error("Each Teams interaction key needs a kid of 1 to 16 [A-Za-z0-9_-]"))
    }
    if (keys.has(kid)) return yield* Effect.die(new Error(`The Teams interaction key kid "${kid}" is repeated`))
    keys.set(kid, yield* Effect.orDie(Jwk.importSecret(input, "HS256")))
  }
  const signing = keys.get(Redacted.value(options.keys[0]).kid!)!
  const context: ButtonContext = { appId: options.appId, tenantId: options.tenantId, kid: signing.kid! }
  const mac = yield* Mac.Mac
  const digest = yield* Digest.Digest

  const hash = (conversationId: string): Effect.Effect<string> =>
    Effect.map(
      digest.digest(Digest.sha256, encoder.encode(baseConversation(conversationId))),
      (bytes) => Base64Url.encode(bytes)
    )

  const sign = <S extends Schema.Constraint>(schema: S, claims: S["Type"], type: string) =>
    Jwt.sign(schema, claims, signing, { typ: type }).pipe(
      Effect.map(Redacted.value),
      Effect.provideService(Mac.Mac, mac),
      Effect.orDie
    )

  const verify = <A>(
    schema: Schema.ConstraintDecoder<A>,
    token: unknown,
    type: string,
    conversationId: string,
    policy: Jwt.VerifyOptions
  ): Effect.Effect<Option.Option<A>> => {
    if (typeof token !== "string" || token.length > maxTokenLength) return Effect.succeedNone
    return Effect.gen(function*() {
      const header = (yield* Jwt.decodeUnverified(token)).protectedHeader
      const key = header.kid === undefined ? undefined : keys.get(header.kid)
      if (key === undefined) return Option.none<A>()
      const verified = yield* Jwt.verify(schema, token, key, { ...policy, audience: options.appId })
      if (verified.protectedHeader.typ !== type) return Option.none<A>()
      const claims = verified.claims as A & { readonly tid: string; readonly cnv: string }
      if (claims.tid !== options.tenantId || claims.cnv !== (yield* hash(conversationId))) return Option.none<A>()
      return Option.some(verified.claims)
    }).pipe(
      Effect.provideService(Mac.Mac, mac),
      Effect.catch(() => Effect.succeedNone)
    )
  }

  return {
    signButton: (conversationId, button) => {
      const refusal = checkButton(button)
      if (refusal !== undefined) return Effect.fail(refusal)
      return Effect.flatMap(
        hash(conversationId),
        (cnv) => sign(ButtonClaims, buttonClaims(context, cnv, button), typ.button)
      )
    },
    verifyButton: (token, activity) =>
      Effect.map(
        verify(ButtonClaims, token, typ.button, activity.conversationId, {}),
        Option.map((claims) => ({ id: claims.id, ...(claims.val === undefined ? {} : { value: claims.val }) }))
      ),
    signDialog: (dialog) => {
      const refusal = checkModal(dialog.modal) ??
        (dialog.userId.length > limits.id || (dialog.messageId?.length ?? 0) > limits.id ||
            dialog.conversationId.length > limits.id
          ? invalidRequest("id_too_long")
          : undefined)
      if (refusal !== undefined) return Effect.fail(refusal)
      return Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const exp = Math.floor((now + Duration.toMillis(dialog.ttl ?? defaultDialogTtl)) / 1000)
        const { metadata } = dialog.modal
        return yield* sign(DialogClaims, {
          aud: options.appId,
          tid: options.tenantId,
          cnv: yield* hash(dialog.conversationId),
          cid: dialog.conversationId,
          sub: dialog.userId,
          exp,
          ...(dialog.messageId === undefined ? {} : { mid: dialog.messageId }),
          def: definitionOf(dialog.modal),
          ...(metadata === undefined ? {} : { md: metadata })
        }, typ.dialog)
      })
    },
    verifyDialog: (token, activity) =>
      Effect.map(
        verify(DialogClaims, token, typ.dialog, activity.conversationId, {
          subject: activity.userId,
          requiredClaims: ["exp", "sub"]
        }),
        (verified) =>
          verified.pipe(
            Option.filter((claims) => claims.cid === activity.conversationId),
            Option.map((claims): Dialog => ({
              conversationId: claims.cid,
              ...(claims.mid === undefined ? {} : { messageId: claims.mid }),
              modal: { ...claims.def, ...(claims.md === undefined ? {} : { metadata: claims.md }) }
            }))
          )
      ),
    tokenLength: (button) => buttonTokenLength(context, button)
  }
})
