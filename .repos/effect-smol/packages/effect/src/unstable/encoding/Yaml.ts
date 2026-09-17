/**
 * Parses YAML configuration files.
 *
 * This is a focused YAML 1.2 configuration parser. It supports block and flow
 * collections, quoted and block scalars, anchors, and aliases.
 *
 * @since 4.0.0
 */

/*
 * The behavior is based on `yaml` 2.9.0.
 *
 * Copyright Eemeli Aro <eemeli@gmail.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

type YamlRecord = Record<string, unknown>

type Line = {
  readonly raw: string
  readonly text: string
  readonly indent: number
  readonly number: number
}

const hasOwn = Object.prototype.hasOwnProperty

const setProperty = (record: YamlRecord, key: string, value: unknown): void => {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value
  })
}

const stripComment = (input: string): string => {
  let quote: "'" | "\"" | undefined
  let escaped = false
  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (quote === "\"") {
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === quote) {
        quote = undefined
      }
    } else if (quote === "'") {
      if (character === quote && input[index + 1] === quote) {
        index++
      } else if (character === quote) {
        quote = undefined
      }
    } else if (character === "'" || character === "\"") {
      quote = character
    } else if (character === "#" && (index === 0 || /\s/.test(input[index - 1]))) {
      return input.slice(0, index).trimEnd()
    }
  }
  return input.trimEnd()
}

const mappingSeparator = (input: string): number => {
  let quote: "'" | "\"" | undefined
  let escaped = false
  let depth = 0
  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (quote === "\"") {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === quote) quote = undefined
    } else if (quote === "'") {
      if (character === quote && input[index + 1] === quote) index++
      else if (character === quote) quote = undefined
    } else if (character === "'" || character === "\"") {
      quote = character
    } else if (character === "[" || character === "{") {
      depth++
    } else if (character === "]" || character === "}") {
      depth--
    } else if (character === ":" && depth === 0 && (input[index + 1] === undefined || /\s/.test(input[index + 1]))) {
      return index
    }
  }
  return -1
}

const parseDoubleQuoted = (input: string): string => {
  if (!input.endsWith("\"") || input.length < 2) {
    throw new SyntaxError("Unterminated double-quoted YAML string")
  }
  let output = ""
  for (let index = 1; index < input.length - 1; index++) {
    const character = input[index]
    if (character !== "\\") {
      output += character
      continue
    }
    const escape = input[++index]
    const escapes: Record<string, string> = {
      "0": "\0",
      a: "\x07",
      b: "\b",
      t: "\t",
      n: "\n",
      v: "\v",
      f: "\f",
      r: "\r",
      e: "\x1b",
      " ": " ",
      "\"": "\"",
      "/": "/",
      "\\": "\\",
      N: "\u0085",
      _: "\u00a0",
      L: "\u2028",
      P: "\u2029"
    }
    if (hasOwn.call(escapes, escape)) {
      output += escapes[escape]
      continue
    }
    if (escape === "x" || escape === "u" || escape === "U") {
      const length = escape === "x" ? 2 : escape === "u" ? 4 : 8
      const hex = input.slice(index + 1, index + 1 + length)
      if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hex)) {
        throw new SyntaxError("Invalid unicode escape in YAML string")
      }
      output += String.fromCodePoint(Number.parseInt(hex, 16))
      index += length
      continue
    }
    throw new SyntaxError(`Invalid YAML escape '\\${escape}'`)
  }
  return output
}

const parseScalar = (input: string): unknown => {
  const value = input.trim()
  if (value.length === 0) return null
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return parseDoubleQuoted(value)
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (/^(?:null|~)$/i.test(value)) return null
  if (/^true$/i.test(value)) return true
  if (/^false$/i.test(value)) return false
  if (/^[+-]?\.inf$/i.test(value)) return value[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  if (/^\.nan$/i.test(value)) return Number.NaN

  const normalized = value.replace(/_/g, "")
  if (/^[+-]?0x[0-9a-f]+$/i.test(normalized)) {
    const sign = normalized[0] === "-" ? -1 : 1
    return sign * Number.parseInt(normalized.replace(/^[+-]?0x/i, ""), 16)
  }
  if (/^[+-]?0o[0-7]+$/i.test(normalized)) {
    const sign = normalized[0] === "-" ? -1 : 1
    return sign * Number.parseInt(normalized.replace(/^[+-]?0o/i, ""), 8)
  }
  if (
    /^[+-]?(?:0|[1-9]\d*)$/.test(normalized) ||
    /^[+-]?(?:(?:0|[1-9]\d*)?\.\d+|(?:0|[1-9]\d*)\.?\d*[eE][+-]?\d+)$/.test(normalized)
  ) {
    return Number(normalized)
  }
  return value
}

const parseKey = (input: string): string => {
  const value = parseScalar(input)
  return value === null || value === undefined ? "" : String(value)
}

class FlowParser {
  private readonly input: string
  private readonly anchors: ReadonlyMap<string, unknown>
  private index = 0

  constructor(input: string, anchors: ReadonlyMap<string, unknown>) {
    this.input = input
    this.anchors = anchors
  }

  parse(): unknown {
    const value = this.parseValue()
    this.skipWhitespace()
    if (this.index !== this.input.length) {
      this.fail("Unexpected flow collection content")
    }
    return value
  }

  private parseValue(): unknown {
    this.skipWhitespace()
    const character = this.peek()
    if (character === "[") return this.parseSequence()
    if (character === "{") return this.parseMapping()
    if (character === "\"" || character === "'") return parseScalar(this.readQuoted(character))
    if (character === "*") {
      this.index++
      const name = this.readUntil(/[,\]}\s]/)
      if (!this.anchors.has(name)) this.fail(`Unknown alias '*${name}'`)
      return this.anchors.get(name)
    }
    return parseScalar(this.readUntil(/[,\]}]/).trim())
  }

  private parseSequence(): Array<unknown> {
    this.expect("[")
    const output: Array<unknown> = []
    this.skipWhitespace()
    if (this.peek() === "]") {
      this.index++
      return output
    }
    while (true) {
      output.push(this.parseValue())
      this.skipWhitespace()
      if (this.peek() === "]") {
        this.index++
        return output
      }
      this.expect(",")
      this.skipWhitespace()
      if (this.peek() === "]") {
        this.index++
        return output
      }
    }
  }

  private parseMapping(): YamlRecord {
    this.expect("{")
    const output: YamlRecord = {}
    this.skipWhitespace()
    if (this.peek() === "}") {
      this.index++
      return output
    }
    while (true) {
      const key = this.parseKey()
      this.skipWhitespace()
      this.expect(":")
      if (hasOwn.call(output, key)) this.fail(`Duplicate key '${key}'`)
      setProperty(output, key, this.parseValue())
      this.skipWhitespace()
      if (this.peek() === "}") {
        this.index++
        return output
      }
      this.expect(",")
      this.skipWhitespace()
      if (this.peek() === "}") {
        this.index++
        return output
      }
    }
  }

  private parseKey(): string {
    this.skipWhitespace()
    const character = this.peek()
    if (character === "\"" || character === "'") {
      return parseKey(this.readQuoted(character))
    }
    return this.readUntil(/:/).trim()
  }

  private readQuoted(quote: string): string {
    const start = this.index++
    let escaped = false
    while (this.index < this.input.length) {
      const character = this.input[this.index++]
      if (quote === "\"" && escaped) escaped = false
      else if (quote === "\"" && character === "\\") escaped = true
      else if (quote === "'" && character === quote && this.input[this.index] === quote) this.index++
      else if (character === quote) return this.input.slice(start, this.index)
    }
    this.fail("Unterminated quoted scalar")
  }

  private readUntil(stop: RegExp): string {
    const start = this.index
    while (this.index < this.input.length && !stop.test(this.peek())) this.index++
    return this.input.slice(start, this.index)
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.peek())) this.index++
  }

  private expect(character: string): void {
    if (this.peek() !== character) this.fail(`Expected '${character}'`)
    this.index++
  }

  private peek(): string {
    return this.input[this.index] ?? ""
  }

  private fail(message: string): never {
    throw new SyntaxError(`${message} at flow offset ${this.index}`)
  }
}

class YamlParser {
  private readonly lines: ReadonlyArray<Line>
  private index = 0
  private readonly anchors = new Map<string, unknown>()

  constructor(lines: ReadonlyArray<Line>) {
    this.lines = lines
  }

  parse(): unknown {
    this.skipIgnored()
    if (this.index >= this.lines.length) return null
    const value = this.parseNode(this.lines[this.index].indent)
    this.skipIgnored()
    if (this.index < this.lines.length) {
      this.fail(this.lines[this.index], "Unexpected content")
    }
    return value
  }

  private parseNode(indent: number): unknown {
    this.skipIgnored()
    const line = this.lines[this.index]
    if (line === undefined) return null
    if (line.indent !== indent) this.fail(line, `Expected indentation of ${indent} spaces`)
    if (line.text === "-" || line.text.startsWith("- ")) return this.parseSequence(indent)
    if (mappingSeparator(line.text) !== -1) return this.parseMapping(indent)
    this.index++
    return this.parseInlineValue(line.text)
  }

  private parseMapping(indent: number): YamlRecord {
    const output: YamlRecord = {}
    while (true) {
      this.skipIgnored()
      const line = this.lines[this.index]
      if (line === undefined || line.indent < indent) return output
      if (line.indent > indent) this.fail(line, `Unexpected indentation of ${line.indent} spaces`)
      const separator = mappingSeparator(line.text)
      if (separator === -1) return output
      this.index++
      this.parseMappingEntry(output, line.text, separator, indent, line)
    }
  }

  private parseMappingEntry(
    output: YamlRecord,
    text: string,
    separator: number,
    indent: number,
    line: Line
  ): void {
    const key = parseKey(text.slice(0, separator).trim())
    const rawValue = text.slice(separator + 1).trim()
    const value = this.parseNodeValue(rawValue, indent)
    if (hasOwn.call(output, key)) this.fail(line, `Duplicate key '${key}'`)
    setProperty(output, key, value)
  }

  private parseSequence(indent: number): Array<unknown> {
    const output: Array<unknown> = []
    while (true) {
      this.skipIgnored()
      const line = this.lines[this.index]
      if (line === undefined || line.indent < indent) return output
      if (line.indent > indent) this.fail(line, `Unexpected indentation of ${line.indent} spaces`)
      if (line.text !== "-" && !line.text.startsWith("- ")) return output
      this.index++
      const item = line.text.slice(1).trimStart()
      const separator = mappingSeparator(item)
      if (separator === -1) {
        output.push(this.parseNodeValue(item, indent))
        continue
      }

      const mapping: YamlRecord = {}
      this.parseMappingEntry(mapping, item, separator, indent + 2, line)
      while (true) {
        this.skipIgnored()
        const continuation = this.lines[this.index]
        if (continuation === undefined || continuation.indent <= indent) break
        if (continuation.indent !== indent + 2) {
          this.fail(continuation, `Expected indentation of ${indent + 2} spaces`)
        }
        const nextSeparator = mappingSeparator(continuation.text)
        if (nextSeparator === -1) this.fail(continuation, "Expected a mapping entry")
        this.index++
        this.parseMappingEntry(mapping, continuation.text, nextSeparator, indent + 2, continuation)
      }
      output.push(mapping)
    }
  }

  private parseNodeValue(rawValue: string, parentIndent: number): unknown {
    let value = rawValue
    let anchor: string | undefined
    const anchorMatch = /^&([^\s,[\]{}]+)(?:\s+(.*))?$/.exec(value)
    if (anchorMatch !== null) {
      anchor = anchorMatch[1]
      value = anchorMatch[2] ?? ""
    }

    let parsed: unknown
    if (value.length === 0) {
      this.skipIgnored()
      const next = this.lines[this.index]
      parsed = next !== undefined && next.indent > parentIndent ? this.parseNode(next.indent) : null
    } else if (/^[|>](?:[1-9]?[+-]?|[+-]?[1-9]?)$/.test(value)) {
      parsed = this.parseBlockScalar(value, parentIndent)
    } else {
      parsed = this.parseInlineValue(value)
    }
    if (anchor !== undefined) this.anchors.set(anchor, parsed)
    return parsed
  }

  private parseInlineValue(value: string): unknown {
    if (value.startsWith("*")) {
      const name = value.slice(1).trim()
      if (!this.anchors.has(name)) throw new SyntaxError(`Unknown YAML alias '*${name}'`)
      return this.anchors.get(name)
    }
    if (value.startsWith("[") || value.startsWith("{")) {
      return new FlowParser(value, this.anchors).parse()
    }
    return parseScalar(value)
  }

  private parseBlockScalar(indicator: string, parentIndent: number): string {
    const style = indicator[0]
    const chomp = indicator.includes("-") ? "strip" : indicator.includes("+") ? "keep" : "clip"
    const explicitIndent = Number.parseInt(indicator.replace(/[^1-9]/g, ""), 10)
    const start = this.index
    let end = start
    let contentIndent = Number.isNaN(explicitIndent) ? Number.POSITIVE_INFINITY : parentIndent + explicitIndent

    while (end < this.lines.length) {
      const line = this.lines[end]
      if (line.raw.trim().length !== 0 && line.indent <= parentIndent) break
      if (line.raw.trim().length !== 0) contentIndent = Math.min(contentIndent, line.indent)
      end++
    }
    if (contentIndent === Number.POSITIVE_INFINITY) contentIndent = parentIndent + 1

    const content: Array<string> = []
    for (let index = start; index < end; index++) {
      const line = this.lines[index]
      if (line.raw.trim().length === 0) {
        content.push("")
      } else if (line.indent < contentIndent) {
        this.fail(line, `Expected block scalar indentation of ${contentIndent} spaces`)
      } else {
        content.push(line.raw.slice(contentIndent))
      }
    }
    this.index = end

    let output = ""
    if (style === "|") {
      output = content.join("\n")
    } else {
      for (let index = 0; index < content.length; index++) {
        output += content[index]
        if (index < content.length - 1) {
          output += content[index].length === 0 || content[index + 1].length === 0 ? "\n" : " "
        }
      }
    }
    if (chomp === "keep") return `${output}\n`
    output = output.replace(/\n+$/, "")
    return chomp === "strip" ? output : `${output}\n`
  }

  private skipIgnored(): void {
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]
      if (line.text.length === 0 || line.text.startsWith("%") || line.text === "---") {
        this.index++
      } else if (line.text === "...") {
        this.index++
        while (this.index < this.lines.length && this.lines[this.index].text.length === 0) this.index++
        if (this.index < this.lines.length) {
          this.fail(this.lines[this.index], "Multiple YAML documents are not supported")
        }
      } else {
        return
      }
    }
  }

  private fail(line: Line, message: string): never {
    throw new SyntaxError(`${message} at line ${line.number}`)
  }
}

/**
 * Parses one YAML document into JavaScript values.
 *
 * The core YAML 1.2 scalar schema is used, so booleans, nulls, and numbers are
 * decoded while date-like values remain strings.
 *
 * @category decoding
 * @since 4.0.0
 */
export const parse = (input: string): unknown => {
  const source = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
  const lines = source.split("\n").map((raw, index): Line => {
    const indentation = /^( *)/.exec(raw)![1].length
    if (raw.slice(0, indentation + 1).includes("\t")) {
      throw new SyntaxError(`Tabs cannot be used for YAML indentation at line ${index + 1}`)
    }
    return {
      raw,
      text: stripComment(raw.slice(indentation)),
      indent: indentation,
      number: index + 1
    }
  })
  return new YamlParser(lines).parse()
}
