import type { Import } from "../../Codegen.ts"
import { tokenize } from "./codeTokens.ts"

export type Imports = ReadonlyArray<
  Import | {
    readonly kind: "SideEffect"
    readonly module: string
    readonly attributes: string
  }
>

const escapes: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
  "\n": "",
  "\r": "",
  "\r\n": ""
}

export function parse(source: string): Imports {
  const fail = (): never => {
    throw new Error(`Invalid import declaration: ${source}`)
  }
  const decode = (text: string): string =>
    text.replace(
      /\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|(\r\n|[\s\S]))/gu,
      (match, point, unit, hex, char, offset) => {
        const digits = point ?? unit ?? hex
        if (digits !== undefined) {
          const value = Number.parseInt(digits, 16)
          return value <= 0x10ffff ? String.fromCodePoint(value) : fail()
        }
        if (
          char === "u" || char === "x" || /[1-9]/.test(char) ||
          (char === "0" && /\d/.test(text[offset + match.length] ?? ""))
        ) return fail()
        return escapes[char] ?? char
      }
    )
  const tokens = tokenize(source).map((token) => {
    const value = decode(token.kind === "string" ? token.text.slice(1, -1) : token.text)
    if (token.kind === "identifier" && !/^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(value)) return fail()
    return { kind: token.kind, value }
  })

  let index = 0
  const at = (value: string): boolean => tokens[index]?.value === value && tokens[index]?.kind !== "string"
  const take = (value: string): boolean => at(value) ? (index++, true) : false
  const expect = (value: string): void => {
    if (!take(value)) fail()
  }
  const identifier = (): string => {
    const token = tokens[index++]
    return token?.kind === "identifier" ? token.value : fail()
  }
  const string = (): string => {
    const token = tokens[index++]
    return token?.kind === "string" ? token.value : fail()
  }
  const imports: Array<Imports[number]> = []
  while (index < tokens.length) {
    expect("import")
    const clause: Array<Omit<Import, "module" | "attributes">> = []
    let typeOnly = false
    if (tokens[index]?.kind !== "string") {
      typeOnly = at("type") && tokens[index + 1]?.value !== "from" && tokens[index + 1]?.value !== ","
        ? (index++, true)
        : false
      if (tokens[index]?.kind === "identifier") {
        clause.push({ kind: "Default", imported: "default", local: identifier(), typeOnly })
        if (!take(",")) expect("from")
      }
      if (take("*")) {
        expect("as")
        clause.push({ kind: "Namespace", imported: "*", local: identifier(), typeOnly })
        expect("from")
      } else if (take("{")) {
        while (!take("}")) {
          let itemTypeOnly = typeOnly
          let token = tokens[index++]
          if (token?.kind !== "identifier" && token?.kind !== "string") return fail()
          if (
            token.kind === "identifier" && token.value === "type" && (
              tokens[index]?.kind === "string" ||
              (tokens[index]?.kind === "identifier" && !at("as")) ||
              (at("as") && (
                [",", "}"].includes(tokens[index + 1]?.value) ||
                (tokens[index + 1]?.value === "as" && tokens[index + 2]?.kind === "identifier")
              ))
            )
          ) {
            itemTypeOnly = true
            token = tokens[index++]
          }
          const imported = token.value
          const local = take("as") ? identifier() : token.kind === "identifier" ? imported : fail()
          clause.push({ kind: "Named", imported, local, typeOnly: itemTypeOnly })
          if (!take(",")) {
            expect("}")
            break
          }
        }
        expect("from")
      } else if (clause.length === 0) {
        return fail()
      }
    }
    const module = string()
    let attributes = ""
    if (at("with") || at("assert")) {
      const keyword = tokens[index++].value
      expect("{")
      const entries: Array<readonly [string, string]> = []
      while (!take("}")) {
        const key = tokens[index]?.kind === "string" ? string() : identifier()
        expect(":")
        entries.push([key, string()])
        if (!take(",")) {
          expect("}")
          break
        }
      }
      attributes = ` ${keyword} { ${
        entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) =>
          `${JSON.stringify(key)}: ${JSON.stringify(value)}`
        ).join(", ")
      } }`
    }
    for (const binding of clause) imports.push({ ...binding, module, attributes })
    // Specifier-level type modifiers preserve module evaluation with verbatimModuleSyntax.
    if (!typeOnly && clause.every((binding) => binding.typeOnly)) {
      imports.push({ kind: "SideEffect", module, attributes })
    }
    take(";")
  }
  return imports
}
