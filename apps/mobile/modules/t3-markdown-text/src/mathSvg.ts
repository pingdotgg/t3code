import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

/** Native SVG paths need no browser, downloaded fonts, or network requests. */
export function mathSvg(source: string, display: boolean, fontSize: number) {
  try {
    // Each expression gets its own macro scope. HTML/URL and require extensions
    // are intentionally excluded from agent-authored formulas.
    const document = mathjax.document("", {
      InputJax: new TeX({ packages: ["base", "ams", "newcommand"], maxBuffer: 10000 }),
      OutputJax: new SVG({ fontCache: "none" }),
    });
    const node = document.convert(source, { display, em: fontSize, ex: fontSize / 2 });
    const xml = adaptor.innerHTML(node);
    const width = (Number(/<svg[^>]*\bwidth="([\d.]+)ex"/.exec(xml)?.[1]) * fontSize) / 2;
    const height = (Number(/<svg[^>]*\bheight="([\d.]+)ex"/.exec(xml)?.[1]) * fontSize) / 2;
    if (
      !Number.isFinite(width + height) ||
      width <= 0 ||
      height <= 0 ||
      width > 100000 ||
      height > 100000 ||
      xml.includes("data-mjx-error")
    )
      return null;
    return { xml, width, height };
  } catch {
    return null;
  }
}
