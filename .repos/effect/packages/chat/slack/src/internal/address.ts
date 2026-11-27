import * as ChatThread from "effect/chat/ChatThread"
import * as Option from "effect/Option"

/** @internal */
export const platform = "slack"

/** @internal */
export interface Parts {
  readonly team: string
  readonly channel: string
  readonly threadTs?: string | undefined
}

/** @internal */
export const thread = (parts: Parts): ChatThread.ChatThread =>
  ChatThread.make(
    platform,
    parts.threadTs === undefined
      ? `${parts.team}/${parts.channel}`
      : `${parts.team}/${parts.channel}/${parts.threadTs}`
  )

/** @internal */
export const parts = (address: ChatThread.ChatThread): Option.Option<Parts> => {
  if (address.platform !== platform) return Option.none()
  const segments = address.id.split("/")
  if (segments.length < 2 || segments.length > 3 || segments.some((segment) => segment.length === 0)) {
    return Option.none()
  }
  return Option.some(
    segments.length === 2
      ? { team: segments[0], channel: segments[1] }
      : { team: segments[0], channel: segments[1], threadTs: segments[2] }
  )
}

/** @internal */
export const isDirectChannel = (channel: string): boolean => channel.startsWith("D")

/** Compares two Slack `ts` values in time order. @internal */
export const compareTs = (a: string, b: string): number => {
  const [aSeconds, aMicros = ""] = a.split(".")
  const [bSeconds, bMicros = ""] = b.split(".")
  const seconds = Number(aSeconds) - Number(bSeconds)
  if (seconds !== 0) return seconds < 0 ? -1 : 1
  const width = Math.max(aMicros.length, bMicros.length)
  const left = aMicros.padEnd(width, "0")
  const right = bMicros.padEnd(width, "0")
  return left < right ? -1 : left > right ? 1 : 0
}
