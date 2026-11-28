import type { Fragment } from "../../Codegen.ts"
import { code, join } from "../codegen.ts"
import { type Token, tokenize } from "./codeTokens.ts"

/** Parse schema expressions and types, keeping their spelling except for tracked references. */
export function parse(source: string, references: ReadonlyMap<string, Fragment>, kind: "runtime" | "Type"): Fragment {
  const replacements: Array<{ readonly token: Token; readonly fragment: Fragment }> = []
  let index = 0
  const fail = (position: number = tokens[index]?.start ?? source.length): never => {
    throw new Error(`Unsupported ${kind} syntax at offset ${position}: ${source}`)
  }
  const tokens = tokenize(source)
  for (const token of tokens) {
    if (token.kind === "identifier" && token.text.includes("\\")) fail(token.start)
  }
  const isLiteral = (token: Token | undefined): boolean => token?.kind === "string" || token?.kind === "number"

  const at = (text: string): boolean => tokens[index]?.text === text
  const take = (text: string): boolean => at(text) ? (index++, true) : false
  const expect = (text: string): void => {
    if (!take(text)) fail()
  }
  const identifier = (): Token => {
    const token = tokens[index]
    if (token?.kind !== "identifier") return fail()
    index++
    return token
  }
  const reference = (token: Token, shorthand = false): void => {
    const fragment = references.get(token.text)
    if (fragment !== undefined) {
      replacements.push({ token, fragment: shorthand ? code`${token.text}: ${fragment}` : fragment })
    }
  }
  const list = (end: string, item: () => void): void => {
    if (take(end)) return
    do {
      item()
      if (!take(",")) break
    } while (!at(end))
    expect(end)
  }
  const path = (): void => {
    reference(identifier())
    while (take(".")) identifier()
  }
  const type = (): void => {
    typeMember()
    while (take("|") || take("&")) typeMember()
  }
  const typeMember = (): void => {
    if (take("readonly") || take("typeof")) {
      typeMember()
      return
    }
    if (take("(")) {
      type()
      expect(")")
    } else if (take("[")) {
      list("]", () => {
        take("...")
        type()
        take("?")
      })
    } else if (take("{")) {
      while (!take("}")) {
        take("readonly")
        if (take("[")) {
          if (tokens[index]?.kind === "identifier" && tokens[index + 1]?.text === ":") {
            identifier()
            expect(":")
            type()
          } else {
            expression()
          }
          expect("]")
        } else if (tokens[index]?.kind === "identifier" || isLiteral(tokens[index])) {
          index++
        } else {
          fail()
        }
        take("?")
        expect(":")
        type()
        if (!take(",") && !take(";") && !at("}")) fail()
      }
    } else if (take("-")) {
      if (!isLiteral(tokens[index++])) fail()
    } else if (isLiteral(tokens[index])) {
      index++
    } else {
      path()
      if (take("<")) list(">", type)
    }
    while (take("[")) expect("]")
  }
  const expression = (): void => {
    if (take("-") || take("+") || take("!")) {
      expression()
      return
    }
    if (take("new")) {
      path()
      expect("(")
      list(")", expression)
    } else if (take("(")) {
      if (take(")")) {
        if (take(":")) type()
        expect("=>")
        expression()
        return
      }
      expression()
      expect(")")
    } else if (take("[")) {
      list("]", () => {
        take("...")
        expression()
      })
    } else if (take("{")) {
      list("}", () => {
        if (take("...")) {
          expression()
          return
        }
        if (take("[")) {
          expression()
          expect("]")
          expect(":")
          expression()
          return
        }
        const key = tokens[index++]
        if (key === undefined || (key.kind !== "identifier" && !isLiteral(key))) fail()
        if (take(":")) expression()
        else if (key.kind === "identifier") reference(key, true)
        else fail()
      })
    } else if (isLiteral(tokens[index])) {
      index++
    } else {
      if (["function", "class", "await", "yield", "import", "const", "let", "return"].includes(tokens[index]?.text)) {
        fail()
      }
      reference(identifier())
    }
    while (true) {
      if (take(".")) {
        identifier()
      } else if (take("[")) {
        expression()
        expect("]")
      } else if (take("(")) {
        list(")", () => {
          take("...")
          expression()
        })
      } else if (take("<")) {
        list(">", type)
        expect("(")
        list(")", expression)
      } else {
        break
      }
    }
  }
  if (kind === "Type") type()
  else expression()
  if (index !== tokens.length) fail()

  const parts: Array<Fragment> = []
  let end = 0
  for (const { token, fragment } of replacements) {
    parts.push(source.slice(end, token.start), fragment)
    end = token.end
  }
  parts.push(source.slice(end))
  return join(parts, "")
}
