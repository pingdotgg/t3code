/**
 * react-native-svg applies neither the CSS custom properties Pele colors with
 * nor CSS-only geometry such as `rx` in a style, so both become attributes.
 * `theme` sets `--pele-*` values; the rest keep Pele's fallbacks.
 */
export function mermaidSvgForNative(svg: string, theme: Readonly<Record<string, string>>): string {
  const rootTag = /^<svg\b[^>]*>/.exec(svg)?.[0];
  if (!rootTag) return svg;
  const declared = styleDeclarations(/\sstyle="([^"]*)"/.exec(rootTag)?.[1] ?? "");
  const resolve = (value: string, depth = 0): string =>
    depth > 8
      ? value
      : value.replace(
          /var\((--[\w-]+)(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g,
          (_match, name: string, fallback: string | undefined) =>
            resolve(theme[name] ?? declared.get(name) ?? fallback ?? "", depth + 1),
        );

  const fontSize = /(\d+(?:\.\d+)?)px/.exec(declared.get("font") ?? "")?.[1] ?? "16";
  const fontFamily = resolve(declared.get("font-family") ?? "sans-serif").replaceAll('"', "'");
  const root = resolve(rootTag.replace(/\sstyle="[^"]*"/, "")).replace(
    />$/,
    ` font-family="${fontFamily}" font-size="${fontSize}">`,
  );
  const body = svg
    .slice(rootTag.length)
    .replace(/\sstyle="([^"]*)"/g, (_match, style: string) =>
      [...styleDeclarations(style)]
        .map(([name, value]) => ` ${name}="${resolve(value).replace(/^(-?[\d.]+)px$/, "$1")}"`)
        .join(""),
    );
  return root + resolve(body);
}

function styleDeclarations(style: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon > 0) {
      declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
  }
  return declarations;
}
