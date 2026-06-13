const ESCAPE_SCRIPT_END = /<\/script>/gi

const ESCAPE_LINE_TERMS = /[\u2028\u2029]/g

/** @internal */
export function escapeJson(spec: unknown): string {
  return JSON.stringify(spec)
    .replace(ESCAPE_SCRIPT_END, "<\\/script>")
    .replace(ESCAPE_LINE_TERMS, (c) => c === "\u2028" ? "\\u2028" : "\\u2029")
}

/** @internal */
export function escape(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
