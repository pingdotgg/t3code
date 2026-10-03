// @effect-diagnostics globalTimers:off - Browser/native previews yield outside an Effect runtime.
// Diagram previews are explicit: ordinary Markdown never loads the layout engine.
const cache = new Map<string, { svg: string; width: number; height: number }>();
let cacheSize = 0;
let pending = 0;
let tail: Promise<unknown> = Promise.resolve();

export function hasClosedMermaidFence(markdown: string, source: string): boolean {
  let fence: string | null = null;
  let mermaid = false;
  let body: string[] = [];
  let matched = false;
  for (const line of markdown.split("\n")) {
    const token = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && token) {
      fence = token[1]!;
      mermaid = token[2]!.trim().toLowerCase() === "mermaid";
      body = [];
    } else if (
      fence &&
      token &&
      token[1]![0] === fence[0] &&
      token[1]!.length >= fence.length &&
      !token[2]!.trim()
    ) {
      if (mermaid && body.join("\n").trim() === source.trim()) matched = true;
      fence = null;
    } else if (fence) body.push(line);
  }
  // Native callbacks identify source, not occurrence. Reject ambiguous open copies.
  return matched && !(fence && mermaid && body.join("\n").trim() === source.trim());
}

export function canPreviewMermaid(source: string): boolean {
  if (source.length === 0 || source.length > 8_000 || /[&;`]/.test(source)) return false;
  const lines = source
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"));
  if (lines.length < 2 || lines.length > 64 || /%%\{|url\s*\(/i.test(source)) return false;
  const [header, ...statements] = lines;
  // A positive static subset prevents the alternative parser from silently
  // dropping unsupported statements. Everything else retains its code block.
  if (/^(?:flowchart|graph) (?:TD|TB|BT|LR|RL)$/.test(header!)) {
    const node = String.raw`\w+(?:\[[^\[\]\n]*\]|\{[^{}\n]*\}|\([^()\n]*\))?`;
    const edge = String.raw`(?:-->|---|==>|-\.->)(?:\|[^|\n]*\|)?`;
    const statement = new RegExp(`^${node}(?:\\s+${edge}\\s*${node})*$`);
    const declarations = new Map<string, string>();
    for (const line of statements) {
      if (!statement.test(line)) return false;
      for (const token of line.matchAll(new RegExp(`(?:^|\\s+${edge}\\s*)(${node})`, "g"))) {
        const match = /^(\w+)(.*)$/.exec(token[1]!)!;
        const id = match[1]!;
        const label = match[2]!;
        if (declarations.has(id) && label && declarations.get(id) !== label) return false;
        if (!declarations.has(id)) declarations.set(id, label);
      }
    }
    return (
      statements.every((line) => statement.test(line)) &&
      (source.match(/-->|---|==>|-\.->/g)?.length ?? 0) <= 60
    );
  }
  if (header === "sequenceDiagram")
    return statements.every(
      (line) =>
        /^(?:participant|actor) \w+(?: as .+)?$/.test(line) ||
        /^\w+(?:->>|-->>|->|-->)\w+: .+$/.test(line),
    );
  if (header === "classDiagram")
    return statements.every(
      (line) =>
        /^class \w+$/.test(line) ||
        /^\w+ (?:<\|--|--\|>|\*--|o--|-->|\.\.>) \w+(?: : .+)?$/.test(line),
    );
  if (header === "erDiagram")
    return statements.every((line) => /^\w+ [|o}{]{2}--[|o}{]{2} \w+ : \w+$/.test(line));
  return false;
}

export function renderMermaidPreview(source: string, theme: "light" | "dark", signal: AbortSignal) {
  if (!canPreviewMermaid(source))
    return Promise.reject(new Error("Diagram is unsupported or too large"));
  const key = `${theme}:${source}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return signal.aborted
      ? Promise.reject(new Error("Preview cancelled"))
      : Promise.resolve(cached);
  }
  if (pending >= 16) return Promise.reject(new Error("Too many diagram previews"));
  pending++;
  const result = tail
    .then(async () => {
      if (signal.aborted) throw new Error("Preview cancelled");
      // Yield between layouts, and skip previews hidden or replaced while queued.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (signal.aborted) throw new Error("Preview cancelled");
      const cached = cache.get(key);
      if (cached) return cached;
      const { renderMermaidSVG } = await import("beautiful-mermaid");
      if (signal.aborted) throw new Error("Preview cancelled");
      const svg = renderMermaidSVG(source, {
        bg: theme === "dark" ? "#171717" : "#ffffff",
        fg: theme === "dark" ? "#e5e5e5" : "#262626",
        font: "Arial",
        interactive: false,
      }).replace(/@import\s+url\([^)]*\);/g, "");
      // Image isolation disables scripts and navigation. Reject external resources
      // too, so saving the generated image cannot introduce active SVG content.
      if (
        /<(?:script|foreignObject|image|a)\b|\son\w+\s*=|\b(?:href|src)\s*=|url\(\s*(?!#)/i.test(
          svg,
        )
      ) {
        throw new Error("Unsafe diagram output");
      }
      const dimensions = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
      const width = Number(dimensions?.[1]);
      const height = Number(dimensions?.[2]);
      if (!(width > 0 && height > 0) || svg.length > 500_000)
        throw new Error("Invalid diagram output");
      const image = { svg, width, height };
      cache.set(key, image);
      cacheSize += svg.length + key.length;
      while (cache.size > 16 || cacheSize > 2_000_000) {
        const oldest = cache.entries().next().value;
        if (!oldest) break;
        cacheSize -= oldest[0].length + oldest[1].svg.length;
        cache.delete(oldest[0]);
      }
      return image;
    })
    .finally(() => {
      pending--;
    });
  tail = result.catch(() => undefined);
  return result;
}
