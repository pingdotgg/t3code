import * as Context from "../../Context.ts"
import * as Redactable from "../../Redactable.ts"
import { stripSearchAndHash } from "./urlParams.ts"

/**
 * The path of the request a client executes, as sent and as recorded in spans
 * and errors.
 *
 * @internal
 */
export interface ClientPath {
  readonly sent: string
  readonly redacted: string
}

/** @internal */
export const CurrentClientPath = Context.Reference<ClientPath | undefined>(
  "effect/http/internal/clientPath/CurrentClientPath",
  { defaultValue: () => undefined }
)

/** @internal */
export const currentClientPath = (): ClientPath | undefined =>
  Context.get((globalThis as any)[Redactable.currentFiberTypeId]?.context ?? Context.empty(), CurrentClientPath)

/**
 * Replaces the path of a URL with its redacted form. A pathname that does not
 * match the expected sent pathname is replaced by `/REDACTED`.
 *
 * @internal
 */
export const redactClientPath = (url: string, path: ClientPath): string => {
  const head = stripSearchAndHash(url)
  const origin = /^[a-z][a-z\d+.-]*:\/\/[^/]*/i.exec(head)?.[0] ?? ""
  const pathname = head.slice(origin.length)
  if (pathname === path.redacted) return url
  const tail = url.slice(head.length)
  return origin + (pathname === path.sent ? path.redacted : "/REDACTED") + tail
}
