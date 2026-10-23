export interface MermaidPalette {
  readonly background: string;
  readonly foreground: string;
  readonly muted: string;
  readonly surface: string;
  readonly surfaceAlt: string;
  readonly border: string;
  readonly accent: string;
  readonly monoFontFamily: string;
}

// Only a nested flowchart cluster's title stroke uses color-mix; its first color is close enough.
const COLOR_MIX = /color-mix\(in srgb,\s*(var\(--[\w-]+\))\s+[\d.]+%,\s*var\(--[\w-]+\)\)/g;

// Pele escapes `<`, `>`, and `&` in label text and attribute values, so `<...>` is always markup.
const MARKUP_TAG = /<[^>]*>/g;
// Labels are text nodes, so substituting only inside attribute values leaves a label that
// happens to read `var(--x)` or `color-mix(...)` untouched.
const ATTRIBUTE = /(\s[\w:-]+=")([^"]*)"/g;

function resolveCssVariables(text: string, variables: ReadonlyMap<string, string>, depth = 0) {
  let resolved = "";
  let index = 0;
  for (let start = text.indexOf("var(", index); start !== -1; start = text.indexOf("var(", index)) {
    let open = 0;
    let end = start + 3;
    for (; end < text.length; end += 1) {
      if (text[end] === "(") open += 1;
      else if (text[end] === ")" && --open === 0) break;
    }
    const body = text.slice(start + 4, end);
    const comma = body.indexOf(",");
    const name = (comma === -1 ? body : body.slice(0, comma)).trim();
    const value = variables.get(name) ?? (comma === -1 ? "" : body.slice(comma + 1).trim());
    resolved +=
      text.slice(index, start) +
      (depth < 8 ? resolveCssVariables(value, variables, depth + 1) : "");
    index = end + 1;
  }
  return resolved + text.slice(index);
}

/**
 * Pele colors its SVG through CSS custom properties on the root element, which
 * react-native-svg cannot resolve, and sizes text from the root's `font`
 * shorthand. Inline the theme into every attribute and keep only what native
 * SVG reads from the root.
 */
export function nativeMermaidSvg(svg: string, palette: MermaidPalette): string {
  const rootEnd = svg.indexOf(">");
  const root = svg.slice(0, rootEnd);
  const style = /\sstyle="([^"]*)"/.exec(root)?.[1] ?? "";
  const variables = new Map([
    ["--pele-bg", palette.background],
    ["--pele-fg", palette.foreground],
    ["--pele-muted", palette.muted],
    ["--pele-line", palette.muted],
    ["--pele-surface", palette.surface],
    ["--pele-surface-alt", palette.surfaceAlt],
    ["--pele-border", palette.border],
    ["--pele-accent", palette.accent],
    ["--pele-font-mono", palette.monoFontFamily],
    ["--pele-radius", "4"],
  ]);
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    const name = declaration.slice(0, colon).trim();
    if (name.startsWith("--")) variables.set(name, declaration.slice(colon + 1).trim());
  }
  const fontSize = /(?:^|;)\s*font:\s*([\d.]+)px/.exec(style)?.[1] ?? "16";
  const nativeRoot = `${root.replace(/\sstyle="[^"]*"/, "")} font-size="${fontSize}" color="var(--_fg)"`;
  return (nativeRoot + svg.slice(rootEnd)).replace(MARKUP_TAG, (tag) =>
    tag.replace(
      ATTRIBUTE,
      (_, open: string, value: string) =>
        `${open}${resolveCssVariables(value.replace(COLOR_MIX, "$1"), variables)}"`,
    ),
  );
}
