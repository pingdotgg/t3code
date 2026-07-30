// Lightweight single-pass TS highlighter, ported from the homegrown one in
// public/landing/lib/TrackCloud.jsx. Outputs HTML with <span class="alc-tok-*">
// elements; the styling for those classes lives in src/styles/marketing.css.
//
// This isn't a real tokenizer — it's a regex sweep that's good enough for the
// short snippets shown in the marketing pages. Real prose code blocks should
// use expressive-code via standard MDX ```ts fences.

const KEYWORDS = new Set([
  "import",
  "export",
  "default",
  "class",
  "extends",
  "const",
  "let",
  "var",
  "function",
  "return",
  "yield",
  "if",
  "else",
  "for",
  "of",
  "in",
  "as",
  "new",
  "typeof",
  "async",
  "await",
  "from",
  "interface",
  "type",
  "null",
  "true",
  "false",
  "this",
  "void",
  "throw",
]);

const RE =
  /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|(`(?:[^`\\]|\\.)*`)|\b([A-Za-z_$][a-zA-Z0-9_$]*)\b|\b(\d+)\b/g;

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlightTS(src: string): string {
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  RE.lastIndex = 0;
  while ((m = RE.exec(src)) !== null) {
    if (m.index > last) out += escape(src.slice(last, m.index));
    if (m[1] || m[2]) {
      out += `<span class="alc-tok-c">${escape(m[0])}</span>`;
    } else if (m[3] || m[4] || m[5]) {
      out += `<span class="alc-tok-s">${escape(m[0])}</span>`;
    } else if (m[6]) {
      const id = m[6];
      if (KEYWORDS.has(id)) {
        out += `<span class="alc-tok-k">${id}</span>`;
      } else if (/^[A-Z]/.test(id)) {
        out += `<span class="alc-tok-t">${id}</span>`;
      } else {
        out += `<span class="alc-tok-v">${id}</span>`;
      }
    } else if (m[7]) {
      out += `<span class="alc-tok-n">${m[0]}</span>`;
    }
    last = RE.lastIndex;
  }
  if (last < src.length) out += escape(src.slice(last));
  return out;
}
