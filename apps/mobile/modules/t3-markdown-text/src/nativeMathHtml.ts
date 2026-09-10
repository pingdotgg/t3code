import { nativeMarkdownRunStyle } from "./nativeMarkdownRunStyle";
import { markdownMath } from "@t3tools/client-runtime/markdown-math";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { AssistiveMmlHandler } from "mathjax-full/js/a11y/assistive-mml.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import type { NativeMarkdownTextRun } from "./nativeMarkdownText";
import type {
  MarkdownFileContextMenu,
  NativeMarkdownTextStyle,
} from "./SelectableMarkdownText.types";

const adaptor = liteAdaptor();
AssistiveMmlHandler(RegisterHTMLHandler(adaptor));
const tex = new TeX({ packages: ["base", "ams"], maxBuffer: 16_384, maxMacros: 1000 });
const renderer = mathjax.document("", { InputJax: tex, OutputJax: new SVG({ fontCache: "none" }) });
const cache = new Map<string, string | null>();
let cacheSize = 0;

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

/** Self-contained SVG needs no font downloads, browser typesetter or network access. */
export function nativeMathSvg(source: string): string | null {
  if (cache.has(source)) {
    const cached = cache.get(source) ?? null;
    cache.delete(source);
    cache.set(source, cached);
    return cached;
  }
  const math = markdownMath(source);
  if (!math) return null;
  let svg: string | null = null;
  try {
    renderer.reset();
    tex.reset();
    const node = renderer.convert(math.tex, { display: math.display });
    const output = adaptor.outerHTML(node);
    if (!output.includes('data-mml-node="merror"')) svg = output;
  } catch {
    // Leave unsupported or malformed math as its original source.
  }
  const size = source.length + (svg?.length ?? 0);
  if (size <= 1_000_000) {
    while (cache.size >= 128 || cacheSize + size > 1_000_000) {
      const oldest = cache.entries().next().value;
      if (!oldest) break;
      cacheSize -= oldest[0].length + (oldest[1]?.length ?? 0);
      cache.delete(oldest[0]);
    }
    cache.set(source, svg);
    cacheSize += size;
  }
  return svg;
}

/** Render typed native text runs, never raw Markdown HTML, inside the math text view. */
export function nativeMathRunHtml(
  run: NativeMarkdownTextRun,
  style: NativeMarkdownTextStyle,
  menu?: MarkdownFileContextMenu,
  iconUri?: string,
  showExternalIcon = true,
): string {
  const resolved = nativeMarkdownRunStyle(run, style, "monospace");
  const css = `color:${resolved.color};font-size:${resolved.fontSize}px;line-height:${resolved.lineHeight}px;font-weight:${resolved.fontWeight};font-style:${resolved.fontStyle};font-family:${resolved.fontFamily};text-decoration:${resolved.textDecorationLine}`;
  if (run.role === "spacer")
    return `<span style="display:block;height:${resolved.lineHeight}px;font-size:0;line-height:0">${escapeHtml(run.text)}</span>`;

  let content = escapeHtml(run.text);
  if (run.mathSource) {
    const math = markdownMath(run.mathSource);
    const source = escapeHtml(run.mathSource);
    const svg = nativeMathSvg(run.mathSource);
    content = `<span class="equation" data-source="${source}">${svg ?? source}</span>`;
    if (math?.display)
      content = `<span class="display"><span class="actions"><button data-copy="${source}">Copy TeX</button><button data-toggle="source" aria-expanded="false">TeX source</button></span><span class="viewport" tabindex="0" role="region" aria-label="Equation">${content}</span><span class="source" hidden>${source}</span></span>`;
  } else if (run.skillName && run.skillLabel) {
    // Match the native skill label while retaining the token for selection copy.
    content = `<span data-copy-source="${escapeHtml(run.text)}"><svg class="inline-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10M7.5 4.5l9 5"/></svg>${escapeHtml(run.skillLabel)}</span>`;
  }
  if (iconUri && (run.fileIcon || showExternalIcon)) {
    const icon =
      run.externalHost && !run.fileIcon
        ? `<span class="inline-icon" aria-hidden="true" style="background:currentColor;mask:url('${escapeHtml(iconUri)}') center/contain no-repeat"></span>`
        : `<img class="inline-icon" alt="" src="${escapeHtml(iconUri)}">`;
    content = icon + content;
  } else if ((run.externalHost && showExternalIcon) || run.fileIcon) {
    content =
      `<span class="inline-icon" aria-hidden="true">${run.fileIcon ? "▤" : "◉"}</span>` + content;
  }
  if (run.href) {
    const href = escapeHtml(run.href);
    const actions =
      run.fileIcon && menu
        ? `<button class="file-actions" aria-label="File actions" data-menu="${escapeHtml(JSON.stringify(menu))}" data-href="${href}">⋯</button>`
        : "";
    return `<a style="${escapeHtml(css)}" href="${href}">${content}</a>${actions}`;
  }
  return `<span style="${escapeHtml(css)}">${content}</span>`;
}
