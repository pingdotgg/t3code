const json5Space = /(?:[\t\n\v\f\r \u00A0\u2028\u2029\uFEFF\p{Zs}]|\/\/[^\n\r\u2028\u2029]*|\/\*[^]*?\*\/)*/uy
const idStart = /[$_\p{ID_Start}]/u
const idPart = /[$\u200C\u200D\p{ID_Continue}]/u
const idName = /[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*/uy
const hexDigits = /[\da-fA-F]*/y
const isDigit = (code: number) => code >= 0x30 && code <= 0x39
const isAsciiIdPart = (code: number) =>
  (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || isDigit(code) || code === 0x5f || code === 0x24

const jsoncSpace = /(?:[ \t\r\n]|\/\/[^\r\n]*|\/\*[^]*?\*\/)*/uy
const jsonNumber = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y

// The escapes JSON and JSON5 share, indexed by the character after the backslash.
// A null prototype keeps absent entries from resolving to inherited properties.
const escapes: Record<number, string | undefined> = Object.create(null)
for (const [escape, value] of ["\"\"", "\\\\", "//", "b\b", "f\f", "n\n", "r\r", "t\t"]) {
  escapes[escape.charCodeAt(0)] = value
}

// Runs of string content that need no further inspection.
const json5Double = /[^"\\\n\r]*/y
const json5Single = /[^'\\\n\r]*/y
// JSON forbids unescaped U+0000 through U+001F.
// oxlint-disable-next-line no-control-regex
const jsonDouble = /[^"\\\x00-\x1f]*/y

type Format = "JSON5" | "JSONC"

export const syntaxError = (text: string, at: number, format: Format): SyntaxError => {
  const json5 = format === "JSON5"
  const lines = text.slice(0, at).split(json5 ? /\r\n|[\n\r\u2028\u2029]/ : /\r\n|[\n\r]/)
  return new SyntaxError(
    `Invalid ${json5 ? "JSON5" : "JSONC"} at line ${lines.length}, column ${lines[lines.length - 1].length + 1}`
  )
}

type Frame =
  | { readonly object: true; readonly value: Record<string, unknown>; key: string; first: boolean }
  | { readonly object: false; readonly value: Array<unknown>; first: boolean }

const set = (object: Record<string, unknown>, key: string, value: unknown): void => {
  // Members are own data properties, as with JSON.parse. Assignment creates one unless
  // the key is inherited (`__proto__`, `constructor`, added accessors, ...), where it
  // could run a setter or throw, so inherited keys are defined directly.
  if (key in Object.prototype) {
    Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true })
  } else object[key] = value
}

// JSONC only uses the strict mode to locate errors after JSON.parse fails.
export const parse = (text: string, format: Format): unknown => {
  const json5 = format === "JSON5"
  const space = json5 ? json5Space : jsoncSpace
  // JSON strings forbid raw characters below U+0020; JSON5 strings only forbid line breaks.
  const plainFloor = json5 ? 0 : 0x20
  let i = 0

  const fail = (at: number): never => {
    throw syntaxError(text, at, format)
  }

  /** Skips whitespace and comments, rejecting a `/` that starts neither. */
  const skip = () => {
    // ASCII whitespace dominates formatted documents; the pattern handles the rest.
    let code = text.charCodeAt(i)
    while (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) code = text.charCodeAt(++i)
    if (code > 0x20 && code !== 0x2f && code < 0xa0) return
    space.lastIndex = i
    space.test(text)
    i = space.lastIndex
    if (text.charCodeAt(i) === 0x2f) {
      fail(text.charAt(i + 1) === "*" ? text.length : i + 1)
    }
  }

  /** Advances past a sticky pattern at `i`, returning the matched length. */
  const run = (pattern: RegExp) => {
    pattern.lastIndex = i
    const length = pattern.test(text) ? pattern.lastIndex - i : 0
    i += length
    return length
  }

  const word = <A>(literal: string, result: A): A => {
    if (!text.startsWith(literal, i)) {
      let at = i
      while (text.charAt(at) === literal[at - i]) at++
      fail(at)
    }
    i += literal.length
    return result
  }

  const hex = (count: number) => {
    let value = 0
    for (const end = i + count; i < end; i++) {
      const code = text.charCodeAt(i)
      const lower = code | 0x20
      if (isDigit(code)) value = value * 16 + code - 0x30
      else if (lower >= 0x61 && lower <= 0x66) value = value * 16 + lower - 0x57
      else fail(i)
    }
    return String.fromCharCode(value)
  }

  const number = () => {
    if (!json5) {
      const start = i
      if (run(jsonNumber) === 0) fail(i)
      return Number(text.slice(start, i))
    }
    let code = text.charCodeAt(i)
    let sign = 1
    if (code === 0x2b || code === 0x2d) {
      if (code === 0x2d) sign = -1
      code = text.charCodeAt(++i)
    }
    const start = i
    if (code === 0x49) return word("Infinity", sign * Infinity)
    if (code === 0x4e) return word("NaN", NaN)
    if (code === 0x30 && (text.charCodeAt(i + 1) | 0x20) === 0x78) {
      i += 2
      if (run(hexDigits) === 0) fail(i)
      return sign * Number(text.slice(start, i))
    }
    // Integers below 2^53 are accumulated directly; anything else goes through Number.
    let integer = 0
    if (code === 0x30) code = text.charCodeAt(++i)
    else if (isDigit(code)) {
      do {
        integer = integer * 10 + code - 0x30
        code = text.charCodeAt(++i)
      } while (isDigit(code))
    } else if (code !== 0x2e) fail(i)
    if (code !== 0x2e && code !== 0x65 && code !== 0x45 && i - start < 16) return sign * integer
    if (code === 0x2e) {
      const fraction = ++i
      while (isDigit(text.charCodeAt(i))) i++
      // A leading decimal point needs digits after it; a trailing one does not.
      if (i === fraction && fraction === start + 1) fail(i)
      code = text.charCodeAt(i)
    }
    if (code === 0x65 || code === 0x45) {
      code = text.charCodeAt(++i)
      if (code === 0x2b || code === 0x2d) i++
      const exponent = i
      while (isDigit(text.charCodeAt(i))) i++
      if (i === exponent) fail(i)
    }
    return sign * Number(text.slice(start, i))
  }

  const string = (quote: number) => {
    const plain = quote === 0x27 ? json5Single : json5 ? json5Double : jsonDouble
    let result = ""
    for (i++;;) {
      // Plain content runs until the quote, an escape, a line break, a control character
      // JSON forbids, or the end of input, where `code` is NaN and fails the last test.
      const start = i
      let code = text.charCodeAt(i)
      // Short runs are cheaper to scan by hand; long runs are handed to the pattern.
      const handoff = i + 24
      while (code !== quote && code !== 0x5c && code !== 0x0a && code !== 0x0d && code >= plainFloor) {
        if (++i === handoff) {
          run(plain)
          code = text.charCodeAt(i)
          break
        }
        code = text.charCodeAt(i)
      }
      result += text.slice(start, i)
      i++
      if (code === quote) return result
      // Anything else that stops a plain run is an escape or a forbidden character.
      if (code !== 0x5c) fail(i - 1)
      const escape = text.charCodeAt(i++)
      const simple = escapes[escape]
      if (simple !== undefined) result += simple
      else if (escape === 0x75) result += hex(4)
      else if (!json5 || i > text.length || (escape >= 0x31 && escape <= 0x39)) fail(i - 1)
      else if (escape === 0x76) result += "\v"
      else if (escape === 0x78) result += hex(2)
      else if (escape === 0x30) {
        if (isDigit(text.charCodeAt(i))) fail(i)
        result += "\0"
      } else if (escape === 0x0d) {
        // A CR LF line continuation contributes nothing, like a single line terminator.
        if (text.charCodeAt(i) === 0x0a) i++
      } else if (escape !== 0x0a && escape !== 0x2028 && escape !== 0x2029) result += text[i - 1]
    }
  }

  const identifier = () => {
    const start = i
    let code = text.charCodeAt(i)
    if (isAsciiIdPart(code) && !isDigit(code)) {
      do code = text.charCodeAt(++i)
      while (isAsciiIdPart(code))
      // Past an ASCII name, only an escape or a non-ASCII character can continue it.
      if (code !== 0x5c && !(code >= 0x80)) return text.slice(start, i)
      i = start
    }
    run(idName)
    let name = text.slice(start, i)
    if (name !== "" && text.charAt(i) !== "\\") return name
    // Escapes are validated one code point at a time.
    for (;;) {
      const at = i
      const valid = name === "" ? idStart : idPart
      let c = String.fromCodePoint(text.codePointAt(i) ?? 0)
      if (c === "\\") {
        if (text.charAt(i + 1) !== "u") fail(i + 1)
        i += 2
        c = hex(4)
        if (!valid.test(c)) fail(at)
      } else if (i < text.length && valid.test(c)) i += c.length
      else if (name === "") fail(i)
      else return name
      name += c
    }
  }

  const stack: Array<Frame> = []

  /**
   * Reads a value at `i`, which must already be past any whitespace. Opening a
   * collection returns `undefined`; the collection is completed later.
   */
  const value = (): unknown => {
    const code = text.charCodeAt(i)
    switch (code) {
      case 0x7b:
        stack.push({ object: true, value: {}, key: "", first: true })
        i++
        return undefined
      case 0x5b:
        stack.push({ object: false, value: [], first: true })
        i++
        return undefined
      case 0x22:
        return string(0x22)
      case 0x27:
        return json5 ? string(0x27) : fail(i)
      case 0x6e:
        return word("null", null)
      case 0x74:
        return word("true", true)
      case 0x66:
        return word("false", false)
      case 0x2b:
      case 0x2d:
      case 0x2e:
      case 0x49:
      case 0x4e:
        return number()
    }
    return isDigit(code) ? number() : fail(i)
  }

  /** After a member: consumes a comma unless the collection ends. */
  const separated = (close: number) => {
    skip()
    const code = text.charCodeAt(i)
    if (code === close) return
    if (code !== 0x2c) fail(i)
    i++
    skip()
    if (!json5 && text.charCodeAt(i) === close) fail(i)
  }

  skip()
  let result = value()
  // An explicit stack keeps deep nesting off the call stack.
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    const close = frame.object ? 0x7d : 0x5d
    if (frame.first) skip()
    else separated(close)
    if (text.charCodeAt(i) === close) {
      stack.pop()
      i++
      const parent = stack[stack.length - 1]
      if (parent === undefined) result = frame.value
      else if (parent.object) set(parent.value, parent.key, frame.value)
      else parent.value.push(frame.value)
      continue
    }
    frame.first = false
    if (!frame.object) {
      const item = value()
      if (item !== undefined) frame.value.push(item)
    } else {
      const quote = text.charCodeAt(i)
      if (!json5 && quote !== 0x22) fail(i)
      const key = quote === 0x22 || quote === 0x27 ? string(quote) : identifier()
      skip()
      if (text.charCodeAt(i++) !== 0x3a) fail(i - 1)
      skip()
      const item = value()
      if (item === undefined) frame.key = key
      else set(frame.value, key, item)
    }
  }
  skip()
  if (i < text.length) fail(i)
  return result
}
