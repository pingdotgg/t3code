import * as Context from "effect/Context"

/** @internal */
export interface PostOptions {
  readonly notify?: { readonly users?: ReadonlyArray<string> | undefined } | undefined
  readonly silent?: boolean | undefined
}

/** @internal */
export const CurrentPostOptions = Context.Reference<PostOptions>("@effect/chat-telegram/CurrentPostOptions", {
  defaultValue: () => ({})
})
