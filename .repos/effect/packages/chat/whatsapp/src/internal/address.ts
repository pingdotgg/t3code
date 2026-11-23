import * as ChatThread from "effect/chat/ChatThread"
import * as Option from "effect/Option"

/** @internal */
export const platform = "whatsapp"

/** @internal */
export interface Parts {
  readonly phoneNumberId: string
  readonly kind: "user" | "group"
  readonly id: string
}

const digits = /^\d+$/

/**
 * A business-scoped user id, such as `US.13491208655302741918`, or a parent
 * one, such as `US.ENT.11815799212886844830`. The grammar is read from
 * examples, not from a specification.
 *
 * @internal
 */
export const isBsuid = (id: string): boolean => /^[A-Z]{2}(?:\.[A-Z0-9]+)+$/.test(id)

/** A phone number in digits, or a BSUID. @internal */
export const isUser = (id: string): boolean => digits.test(id) || isBsuid(id)

/** @internal */
export const thread = (parts: Parts): ChatThread.ChatThread =>
  ChatThread.make(platform, `${parts.phoneNumberId}/${parts.kind === "user" ? "u" : "g"}/${parts.id}`)

/** @internal */
export const parts = (address: ChatThread.ChatThread): Option.Option<Parts> => {
  if (address.platform !== platform) return Option.none()
  const segments = address.id.split("/")
  if (segments.length !== 3 || !digits.test(segments[0]) || segments[2].length === 0) return Option.none()
  const [phoneNumberId, kind, id] = segments
  if (kind === "u") return isUser(id) ? Option.some({ phoneNumberId, kind: "user", id }) : Option.none()
  if (kind === "g") return Option.some({ phoneNumberId, kind: "group", id })
  return Option.none()
}
