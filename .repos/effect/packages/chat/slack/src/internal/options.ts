import * as Context from "effect/Context"

/** @internal */
export type SessionStatus = "active" | "processing" | "suspended" | "closed"

/** @internal */
export interface PostOptions {
  readonly notify?: {
    readonly users?: ReadonlyArray<string> | undefined
    readonly groups?: ReadonlyArray<string> | undefined
    readonly broadcast?: boolean | undefined
  } | undefined
  readonly unfurl?: boolean | undefined
  readonly nativeStream?: boolean | undefined
  readonly recipientTeamId?: string | undefined
  readonly sessionStatusAtEnd?: SessionStatus | undefined
}

/** @internal */
export const CurrentPostOptions = Context.Reference<PostOptions>("@effect/chat-slack/CurrentPostOptions", {
  defaultValue: () => ({})
})
