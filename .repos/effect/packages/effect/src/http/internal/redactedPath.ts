import { getClosingParenthensePosition } from "../FindMyWay/internal/router.ts"
import type { HttpServerRequest } from "../HttpServerRequest.ts"
import { stripSearchAndHash, toPath } from "./urlParams.ts"

const STATIC = "s"
const PARAM = "p"
const REDACTED = "r"

/**
 * `kinds[i]` classifies `text[i]` as static (`"s"`), param (`"p"`), or redacted (`"r"`).
 *
 * @internal
 */
export interface RedactedPath {
  readonly text: string
  readonly kinds: string
}

/** @internal */
export type Template = ReadonlyArray<string | { readonly name: string; readonly redacted: boolean }>

/** @internal */
export const compile = (path: string, redactedParams: ReadonlyArray<string>): Template => {
  const parts: Array<string | { name: string; redacted: boolean }> = []
  // FindMyWay assigns regex captures to params in order, so a constraint
  // without exactly one capture shifts values onto the wrong names.
  let ambiguous = false
  let text = ""
  for (let i = 0; i < path.length; i++) {
    const char = path[i]
    if (char === ":" && path[i + 1] === ":") {
      text += ":"
      i++
      continue
    } else if (char !== ":" && char !== "*") {
      text += char
      continue
    }
    let end = i + 1
    if (char === ":") {
      while (
        end < path.length && !"(-./".includes(path[end]) &&
        !(path[end] === "?" && (end === path.length - 1 || path[end + 1] === "/"))
      ) end++
    }
    const name = char === "*" ? "*" : path.slice(i + 1, end)
    if (text !== "") parts.push(text)
    text = ""
    parts.push({ name, redacted: redactedParams.includes(name) })
    if (char === "*") continue
    if (path[end] === "(") {
      const close = getClosingParenthensePosition(path, end)
      ambiguous ||= countCaptures(path.slice(end, close + 1)) !== 1
      i = close
    } else {
      i = path[end] === "?" ? end : end - 1
    }
  }
  if (text !== "") parts.push(text)
  return ambiguous ? parts.map((part) => typeof part === "string" ? part : { name: part.name, redacted: true }) : parts
}

const countCaptures = (regex: string): number => {
  try {
    return new RegExp(regex + "|").exec("")!.length - 1
  } catch {
    return -1
  }
}

/** @internal */
export const render = (template: Template, params: Readonly<Record<string, string | undefined>>): RedactedPath => {
  let text = ""
  let kinds = ""
  for (const part of template) {
    if (typeof part === "string") {
      text += part
      kinds += STATIC.repeat(part.length)
      continue
    }
    const value = params[part.name]
    if (value === undefined) {
      // Absent optional param or wildcard is always last and drops its whole segment.
      const slash = Math.max(text.lastIndexOf("/"), 0)
      text = text.slice(0, slash)
      kinds = kinds.slice(0, slash)
      break
    }
    const encoded = part.name === "*" ? value.split("/").map(encodeSegment).join("/") : encodeSegment(value)
    text += encoded
    kinds += (part.redacted ? REDACTED : PARAM).repeat(encoded.length)
  }
  // A bare wildcard captures the leading slash, which stays visible.
  return text.startsWith("/") ? { text, kinds: STATIC + kinds.slice(1) } : { text: "/" + text, kinds: STATIC + kinds }
}

const encodeSegment = (segment: string): string => {
  try {
    return encodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Merges a nested router's redacted path without weakening outer redactions.
 *
 * @internal
 */
export const combine = (
  previous: RedactedPath | undefined,
  next: RedactedPath,
  request: HttpServerRequest
): RedactedPath => {
  if (previous === undefined) {
    // Restore the mount prefix stripped from `request.url`.
    const local = stripSearchAndHash(request.url)
    const original = toPath(request.originalUrl)
    if (local === original || !original.endsWith(local)) return next
    const prefix = original.slice(0, original.length - local.length)
    return { text: prefix + next.text, kinds: PARAM.repeat(prefix.length) + next.kinds }
  }
  if (!previous.text.endsWith(next.text)) {
    // Unaligned paths: redact all params conservatively.
    return { text: previous.text, kinds: previous.kinds.replaceAll(PARAM, REDACTED) }
  }
  const offset = previous.text.length - next.text.length
  let kinds = previous.kinds.slice(0, offset)
  for (let i = 0; i < next.kinds.length; i++) {
    kinds += next.kinds[i] === REDACTED ? REDACTED : previous.kinds[offset + i]
  }
  return { text: previous.text, kinds }
}

/** @internal */
export const format = (path: RedactedPath): string => {
  let out = ""
  let last = 0
  for (const run of path.kinds.matchAll(/r+/g)) {
    out += path.text.slice(last, run.index) + "REDACTED"
    last = run.index + run[0].length
  }
  return out + path.text.slice(last)
}
