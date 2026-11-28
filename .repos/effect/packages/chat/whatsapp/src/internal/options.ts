import * as Context from "effect/Context"
import type { WhatsAppPostOptions } from "../WhatsAppChat.ts"

/** @internal */
export const CurrentPostOptions = Context.Reference<WhatsAppPostOptions>("@effect/chat-whatsapp/CurrentPostOptions", {
  defaultValue: () => ({})
})

/** @internal */
export const defaultListButton = "Options"

/** @internal */
export const defaultButtonsSection = "Actions"
