/**
 * Escaping for what the adapter sends Slack.
 *
 * - The Markdown, in a `markdown` block or in `markdown_text`: a `<`
 *   outside inline and fenced code becomes `&lt;`, unless the scoped notify
 *   options allow that token.
 * - The `text` beside a `markdown` block, from which Slack decides who is
 *   mentioned: every `<`, `>` and `&` becomes an entity, in code too, and
 *   only the tokens the block keeps intact stay intact.
 * - A stream append, which has no `text`: `escapeStream` puts U+200B after
 *   whatever spells the `<` of a token shape, in prose and in code alike.
 */

/** @internal */
export interface Notify {
  readonly users?: ReadonlyArray<string> | undefined
  readonly groups?: ReadonlyArray<string> | undefined
  readonly broadcast?: boolean | undefined
}

interface Fence {
  readonly char: string
  readonly length: number
}

/**
 * Where an escaper left off: the fence open at the start of the current line,
 * and the raw text of that line consumed so far.
 *
 * @internal
 */
export interface State {
  readonly fence: Fence | undefined
  readonly line: string
}

/** @internal */
export const initialState: State = { fence: undefined, line: "" }

/** @internal */
export interface Escaped {
  /** What to send for the consumed part of the input. */
  readonly sent: string
  /** How many characters of the input were consumed. The rest is held. */
  readonly consumed: number
  readonly state: State
}

/** Past this many held characters, an undecided `<` is escaped anyway. */
const holdBound = 300

const tokenPattern = /^<(@([UW][A-Z0-9]+)|!subteam\^([A-Z0-9]+)|!(here|channel|everyone))(\|[^<>]*)?>/

const allowsAny = (notify: Notify): boolean =>
  (notify.users?.length ?? 0) > 0 || (notify.groups?.length ?? 0) > 0 || notify.broadcast === true

const allowedToken = (rest: string, notify: Notify): number => {
  const match = tokenPattern.exec(rest)
  if (match === null) return 0
  const [token, , user, group, broadcast] = match
  if (user !== undefined) return notify.users?.includes(user) ? token.length : 0
  if (group !== undefined) return notify.groups?.includes(group) ? token.length : 0
  return broadcast !== undefined && notify.broadcast === true ? token.length : 0
}

const openingFence = /^ {0,3}(`{3,}|~{3,})(.*)$/
const closingFence = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/

const opensFence = (line: string): Fence | undefined => {
  const match = openingFence.exec(line)
  if (match === null) return undefined
  const marker = match[1]
  if (marker[0] === "`" && match[2].includes("`")) return undefined
  return { char: marker[0], length: marker.length }
}

const closesFence = (line: string, fence: Fence): boolean => {
  const match = closingFence.exec(line)
  return match !== null && match[1][0] === fence.char && match[1].length >= fence.length
}

const backtickRun = (line: string, start: number): number => {
  let end = start
  while (line[end] === "`") end++
  return end - start
}

/**
 * The code spans of one line, as `[start, end)` pairs, and the position of a
 * backtick run that opens a span the line has not closed yet.
 */
const codeSpans = (line: string): { readonly spans: Array<readonly [number, number]>; readonly open: number } => {
  const spans: Array<readonly [number, number]> = []
  let i = 0
  let open = -1
  while (i < line.length) {
    if (line[i] !== "`") {
      i++
      continue
    }
    const length = backtickRun(line, i)
    let j = i + length
    let closed = -1
    while (j < line.length) {
      if (line[j] === "`") {
        const run = backtickRun(line, j)
        if (run === length) {
          closed = j
          break
        }
        j += run
      } else {
        j++
      }
    }
    if (closed === -1) {
      if (open === -1) open = i
      i += length
    } else {
      spans.push([i, closed + length])
      i = closed + length
    }
  }
  return { spans, open }
}

/**
 * Escapes `text`, continuing from `state`. Without `flush`, a `<` whose
 * meaning the rest of the stream could still change is held: an unclosed
 * token that the notify options might allow, or one after a backtick the line
 * has not closed yet. With `flush`, or once the held text passes a bound,
 * it is escaped.
 *
 * @internal
 */
export const escape = (
  text: string,
  notify: Notify,
  options?: {
    readonly state?: State | undefined
    readonly flush?: boolean | undefined
    /** Write every `<`, `>` and `&` as an entity, apart from allowed tokens. */
    readonly entities?: boolean | undefined
    /** Called with the span in the output of each allowed token kept intact. */
    readonly onToken?: ((start: number, end: number) => void) | undefined
  }
): Escaped => {
  const state = options?.state ?? initialState
  const flush = options?.flush === true
  const entities = options?.entities === true
  const full = state.line + text
  const offset = state.line.length
  const anyAllowed = allowsAny(notify)
  let fence = state.fence
  let out = ""
  let lineStart = 0
  const emit = (from: number, to: number, piece?: string) => {
    if (to <= offset) return
    if (piece !== undefined) out += piece
    else {
      const slice = full.slice(Math.max(from, offset), to)
      out += entities ? textEntities(slice) : slice
    }
  }
  while (lineStart <= full.length) {
    const newline = full.indexOf("\n", lineStart)
    const complete = newline !== -1
    const lineEnd = complete ? newline : full.length
    const line = full.slice(lineStart, lineEnd)
    if (fence !== undefined) {
      emit(lineStart, lineEnd)
      if (complete && closesFence(line, fence)) fence = undefined
    } else {
      const opener = complete ? opensFence(line) : undefined
      const { open, spans } = opener === undefined ? codeSpans(line) : { open: -1, spans: [] }
      let i = 0
      let span = 0
      while (i < line.length) {
        while (span < spans.length && spans[span][1] <= i) span++
        if (span < spans.length && spans[span][0] <= i) {
          emit(lineStart + i, lineStart + spans[span][1])
          i = spans[span][1]
          continue
        }
        const next = line.indexOf("<", i)
        const stop = next === -1 ? line.length : Math.min(next, span < spans.length ? spans[span][0] : line.length)
        if (stop > i) {
          emit(lineStart + i, lineStart + stop)
          i = stop
          continue
        }
        const at = lineStart + i
        const rest = line.slice(i)
        const undecided = !flush && !complete && full.length - at <= holdBound && (
          (open !== -1 && open < i) ||
          (anyAllowed && !rest.includes(">") && /^<(@|!)?[\w^|]*$/.test(rest))
        )
        if (undecided) {
          return {
            sent: out,
            consumed: at - offset,
            state: { fence, line: full.slice(lineStart, at) }
          }
        }
        const token = allowedToken(rest, notify)
        if (token > 0) {
          const start = out.length
          emit(at, at + token, at >= offset ? rest.slice(0, token) : undefined)
          if (at >= offset) options?.onToken?.(start, out.length)
          i += token
        } else {
          emit(at, at + 1, at >= offset ? "&lt;" : undefined)
          i += 1
        }
      }
      if (opener !== undefined) fence = opener
    }
    if (!complete) {
      return { sent: out, consumed: full.length - offset, state: { fence, line } }
    }
    emit(lineEnd, lineEnd + 1)
    lineStart = lineEnd + 1
  }
  return { sent: out, consumed: full.length - offset, state: { fence, line: "" } }
}

const entityOf: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" }

const textEntities = (text: string): string => text.replace(/[&<>]/g, (char) => entityOf[char])

const zeroWidthSpace = "\u200B"

/** The character references a stream decodes for `<`, `@` and `!`, each only with its semicolon. */
const references: ReadonlyArray<readonly [RegExp, string]> = [
  [/&(?:lt|LT|#0*60|#[xX]0*3[cC]);/y, "<"],
  [/&(?:commat|#0*64|#[xX]0*40);/y, "@"],
  [/&(?:excl|#0*33|#[xX]0*21);/y, "!"]
]

const referenceNames = ["lt", "LT", "commat", "excl"]

/** Whether `text`, from its `&` on, could still grow into one of `references`. */
const unfinishedReference = (text: string): boolean => {
  const body = text.slice(1)
  return /^#(?:[0-9]*|[xX][0-9a-fA-F]*)$/.test(body) || referenceNames.some((name) => name.startsWith(body))
}

/** The start of a token an allowed one could still complete, label included. */
const unclosedToken = /^<[@!][\w^]*(?:\|[^<>]*)?$/

interface Decoded {
  readonly char: string
  /** How many characters of the input spell it. */
  readonly length: number
}

/**
 * The character at `i` in the decoded view of `line`, which must be within
 * it. A reference may have any number of leading zeros.
 */
const decodeAt = (line: string, i: number): Decoded => {
  if (line[i] === "&") {
    for (const [pattern, char] of references) {
      pattern.lastIndex = i
      const match = pattern.exec(line)
      if (match !== null) return { char, length: match[0].length }
    }
  }
  return { char: line[i], length: 1 }
}

/**
 * The character at `i` in the decoded view of `line`. `undefined` past
 * the end of the text, and `unfinished` where the next chunk could still
 * change it.
 */
const decodedAt = (line: string, i: number, ended: boolean): Decoded | "unfinished" | undefined => {
  if (i >= line.length) return ended ? undefined : "unfinished"
  const decoded = decodeAt(line, i)
  return decoded.char === "&" && !ended && unfinishedReference(line.slice(i)) ? "unfinished" : decoded
}

/** `line` from `i` to its first `>`, or to its end, decoded, with the end in `line` of each decoded character. */
const decodeToken = (line: string, i: number): { readonly text: string; readonly ends: ReadonlyArray<number> } => {
  const close = line.indexOf(">", i)
  const end = close === -1 ? line.length : close + 1
  let text = ""
  const ends: Array<number> = []
  for (let j = i; j < end;) {
    const decoded = decodeAt(line, j)
    text += decoded.char
    j += decoded.length
    ends.push(j)
  }
  return { text, ends }
}

/**
 * Escapes a stream's Markdown, continuing from `state`. Slack decodes the
 * character references for `<`, `@` and `!` in a stream, joins one split
 * across two appends, and has no `text` to send beside it, so:
 *
 * - Token shapes are found on the decoded view, which decodes those
 *   references only with their semicolon, in prose and in code alike. A
 *   shape is `<@`, or `<!` followed by an ASCII letter.
 * - On a shape, U+200B goes straight after whatever spells the `<`, and the
 *   rest is left as written. A token the notify options allow is sent as it
 *   is.
 * - Every other `<` keeps the rule of `escape`: `&lt;` outside code, as
 *   written inside it.
 *
 * Without `flush`, it holds what the next chunk could still change: a
 * `<` with too little after it to tell, a trailing reference that is not
 * finished, an unclosed token the notify options might allow, and a `<`
 * after a backtick the line has not closed yet. Past a bound, or with
 * `flush`, it decides with what it has. A shape that only the next chunk
 * completes, after such a write, gets U+200B at the start of the next write,
 * since Slack reads the writes joined.
 *
 * @internal
 */
export const escapeStream = (
  text: string,
  notify: Notify,
  options?: {
    readonly state?: State | undefined
    readonly flush?: boolean | undefined
  }
): Escaped => {
  const state = options?.state ?? initialState
  const flush = options?.flush === true
  const full = state.line + text
  const offset = state.line.length
  const anyAllowed = allowsAny(notify)
  let fence = state.fence
  let out = ""
  let lineStart = 0
  const emit = (from: number, to: number) => {
    if (to > offset) out += full.slice(Math.max(from, offset), to)
  }
  while (lineStart <= full.length) {
    const newline = full.indexOf("\n", lineStart)
    const complete = newline !== -1
    const lineEnd = complete ? newline : full.length
    const line = full.slice(lineStart, lineEnd)
    const inFence = fence !== undefined
    const opener = !inFence && complete ? opensFence(line) : undefined
    const { open, spans } = inFence || opener !== undefined ? { open: -1, spans: [] } : codeSpans(line)
    const hold = (i: number): Escaped => {
      const at = lineStart + i
      return { sent: out, consumed: at - offset, state: { fence, line: full.slice(lineStart, at) } }
    }
    let i = 0
    let span = 0
    while (i < line.length) {
      const next = line.slice(i).search(/[<&]/)
      if (next === -1) {
        emit(lineStart + i, lineEnd)
        break
      }
      emit(lineStart + i, lineStart + i + next)
      i += next
      const at = lineStart + i
      // What an earlier write sent can't be held.
      const ended = complete || flush || at < offset || full.length - at > holdBound
      const first = decodedAt(line, i, ended)
      if (first === "unfinished") return hold(i)
      if (first === undefined || first.char !== "<") {
        // An `&` that spells no `<`. What it spells is decided where it is used.
        emit(at, at + 1)
        i += 1
        continue
      }
      const second = decodedAt(line, i + first.length, ended)
      if (second === "unfinished") return hold(i)
      let shape = second?.char === "@"
      // Where the text that makes it a shape ends.
      let decided = i + first.length + (second?.length ?? 0)
      if (second?.char === "!") {
        const third = decodedAt(line, decided, ended)
        if (third === "unfinished") return hold(i)
        shape = third !== undefined && third.length === 1 && /[A-Za-z]/.test(third.char)
        decided += third?.length ?? 0
      }
      if (shape) {
        const token = decodeToken(line, i)
        const length = allowedToken(token.text, notify)
        if (length > 0) {
          emit(at, lineStart + token.ends[length - 1])
          i = token.ends[length - 1]
          continue
        }
        if (!ended && anyAllowed && unclosedToken.test(token.text)) return hold(i)
        // A shape an earlier write ended inside, which that write could not see, gets the space at the
        // start of this one: Slack reads the writes joined.
        if (lineStart + decided > offset) {
          emit(at, at + first.length)
          out += zeroWidthSpace
        }
        i += first.length
        continue
      }
      if (first.length > 1) {
        // A reference for `<` that starts no token shape is left as written.
        emit(at, at + first.length)
        i += first.length
        continue
      }
      while (span < spans.length && spans[span][1] <= i) span++
      const inCode = inFence || opener !== undefined || (span < spans.length && spans[span][0] <= i)
      if (!inCode && !ended && open !== -1 && open < i) return hold(i)
      if (inCode) emit(at, at + 1)
      else if (at >= offset) out += "&lt;"
      i += 1
    }
    if (inFence) {
      if (complete && closesFence(line, fence!)) fence = undefined
    } else if (opener !== undefined) {
      fence = opener
    }
    if (!complete) {
      return { sent: out, consumed: full.length - offset, state: { fence, line } }
    }
    emit(lineEnd, lineEnd + 1)
    lineStart = lineEnd + 1
  }
  return { sent: out, consumed: full.length - offset, state: { fence, line: "" } }
}
