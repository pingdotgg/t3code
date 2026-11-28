import type { Mention } from "effect/chat/ChatMessage"

type Kind = Mention["kind"]

interface Target {
  readonly kind: Kind
  readonly id: string
}

/** A mention token as Discord writes it in `content`. */
const tokenPattern = /<@!?(\d+)>|<@&(\d+)>|<#(\d+)>|@(everyone|here)/y

const targetOf = (match: RegExpExecArray): Target => {
  const [, user, role, channel, broadcast] = match
  if (user !== undefined) return { kind: "user", id: user }
  if (role !== undefined) return { kind: "role", id: role }
  if (channel !== undefined) return { kind: "channel", id: channel }
  return { kind: "broadcast", id: broadcast! }
}

const tokenAt = (text: string, index: number): RegExpExecArray | null => {
  tokenPattern.lastIndex = index
  return tokenPattern.exec(text)
}

/**
 * Parses one token, `<@id>`, `<@!id>`, `<@&id>`, `<#id>`, `@everyone`
 * or `@here`, as the whole of `slice`.
 *
 * @internal
 */
export const parseToken = (slice: string): Target | undefined => {
  const match = tokenAt(slice, 0)
  return match === null || match[0].length !== slice.length ? undefined : targetOf(match)
}

/**
 * A token in `content` outside code, with its offsets.
 *
 * @internal
 */
export interface Token extends Target {
  readonly start: number
  readonly end: number
}

const isEscapable = (char: string | undefined): boolean => char !== undefined && /[^0-9A-Za-z\s]/.test(char)

/** The index past the closing run of exactly `n` backticks, or -1. */
const closingRun = (text: string, from: number, n: number): number => {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== "`") continue
    let run = 1
    while (text[i + run] === "`") run++
    if (run === n && i > from) return i + run
    i += run - 1
  }
  return -1
}

/**
 * The mention tokens in `content`, in order, skipping code blocks, inline
 * code and tokens escaped with a backslash, as Discord's Markdown does.
 *
 * @internal
 */
export const tokens = (text: string): Array<Token> => {
  const found: Array<Token> = []
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (char === "\\" && isEscapable(text[i + 1])) {
      i += 2
      continue
    }
    if (char === "`") {
      let n = 1
      while (text[i + n] === "`") n++
      if (n >= 3) {
        const end = text.indexOf("```", i + 3)
        if (end !== -1) {
          i = end + 3
          continue
        }
      }
      const end = closingRun(text, i + n, n)
      i = end === -1 ? i + n : end
      continue
    }
    if (char === "<" || char === "@") {
      const match = tokenAt(text, i)
      if (match !== null) {
        found.push({ ...targetOf(match), start: i, end: i + match[0].length })
        i += match[0].length
        continue
      }
    }
    i++
  }
  return found
}
