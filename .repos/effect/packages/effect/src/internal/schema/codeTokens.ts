export interface Token {
  readonly text: string
  readonly start: number
  readonly end: number
  readonly kind: "identifier" | "string" | "number" | "punctuation"
}

// The final alternative consumes one character; each parser rejects unsupported punctuation.
const pattern = new RegExp(
  [
    /\s+|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\//,
    /(?:[$_\p{ID_Start}]|\\u(?:\{[\da-fA-F]+\}|[\da-fA-F]{4}))(?:[$\u200c\u200d\p{ID_Continue}]|\\u(?:\{[\da-fA-F]+\}|[\da-fA-F]{4}))*/u,
    /"(?:[^"\\\r\n]|\\(?:\r\n|[\s\S]))*"|'(?:[^'\\\r\n]|\\(?:\r\n|[\s\S]))*'/,
    /0[xX][\da-fA-F]+n?|0[bB][01]+n?|0[oO][0-7]+n?|\d+n|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/,
    /\.\.\.|=>|[\s\S]/
  ].map((part) => `(${part.source})`).join("|"),
  "gu"
)

export function tokenize(source: string): Array<Token> {
  const tokens: Array<Token> = []
  for (const match of source.matchAll(pattern)) {
    if (match[1] === undefined) {
      tokens.push({
        text: match[0],
        start: match.index,
        end: match.index + match[0].length,
        kind: match[2] !== undefined
          ? "identifier"
          : match[3] !== undefined
          ? "string"
          : match[4] !== undefined
          ? "number"
          : "punctuation"
      })
    }
  }
  return tokens
}
