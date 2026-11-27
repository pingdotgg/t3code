import { sha1 } from "@noble/hashes/legacy";
import { parseUrl } from "@t3tools/shared/url";
import type JSZip from "jszip";
import {
  archivePath,
  escape,
  find,
  previewImageSize,
  parseXml,
  text,
  type XmlNode,
} from "./documentPreviewXml";
import { officeXmlDecoder } from "./officeArchive";
import { externalUrl } from "./office/links";
import type { EpubLocation, EpubPage } from "./officePreviewProtocol";
import { isPreviewError, PreviewError } from "./previewFailure";

const htmlTags = new Set(
  "a abbr address article aside audio b bdi bdo big blockquote canvas caption cite code col colgroup dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup i ins kbd li main mark nav ol p pre q rp rt ruby s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var video".split(
    " ",
  ),
);
const voidTags = new Set(["br", "hr", "wbr", "img", "col", "input", "source"]);
const formTags = new Set(
  "button datalist fieldset form input label legend meter optgroup option output progress select textarea".split(
    " ",
  ),
);
const staticControls = new Set(["button", "input", "select", "textarea"]);
const svgTags = new Set(
  (
    "svg g a defs desc title path rect circle ellipse line polyline polygon text tspan image use symbol switch textPath clipPath mask pattern marker linearGradient radialGradient stop " +
    "filter feGaussianBlur feColorMatrix feSpecularLighting feDistantLight feComposite feOffset feComponentTransfer feFuncA"
  ).split(" "),
);
const mathTags = new Set(
  (
    "math mrow mi mn mo mtext ms mspace mfrac msqrt mroot mstyle merror mpadded mphantom mfenced menclose " +
    "msub msup msubsup munder mover munderover mmultiscripts mprescripts none mtable mtr mtd semantics " +
    "mlongdiv mstack msgroup msrow msline mscarries mscarry"
  ).split(" "),
);
const omitted = new Set([
  "head",
  "script",
  "style",
  "iframe",
  "embed",
  "foreignObject",
  "annotation",
  "annotation-xml",
  "template",
  "noscript",
]);
const commonAttrs = [
  "id",
  "class",
  "lang",
  "dir",
  "title",
  "role",
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-hidden",
  "epub:type",
  "hidden",
];
const htmlAttrs = [
  "align",
  "alt",
  "border",
  "cellpadding",
  "cellspacing",
  "valign",
  "name",
  "colspan",
  "rowspan",
  "scope",
  "type",
  "headers",
  "start",
  "value",
  "open",
  "width",
  "height",
];
const formAttrs = [
  ...htmlAttrs,
  "checked",
  "cols",
  "disabled",
  "for",
  "high",
  "label",
  "list",
  "low",
  "max",
  "min",
  "multiple",
  "optimum",
  "placeholder",
  "rows",
  "selected",
  "size",
  "step",
];
const svgAttrs = (
  "x y x1 x2 y1 y2 cx cy r rx ry dx dy width height viewBox preserveAspectRatio transform d points " +
  "fill fill-rule fill-opacity stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset " +
  "stroke-linecap stroke-linejoin stroke-miterlimit opacity display visibility color font-size " +
  "font-family font-weight font-style text-anchor textLength lengthAdjust dominant-baseline letter-spacing word-spacing text-decoration rotate " +
  "gradientUnits gradientTransform spreadMethod fx fy fr offset stop-color stop-opacity clip-path " +
  "clip-rule clipPathUnits mask maskUnits maskContentUnits patternUnits patternContentUnits patternTransform startOffset " +
  "marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient " +
  "filter filterUnits primitiveUnits stdDeviation in in2 result type values color-interpolation-filters " +
  "kernelUnitLength surfaceScale specularExponent specularConstant lighting-color azimuth elevation operator slope intercept"
).split(" ");
const mathAttrs = (
  "display displaystyle mathvariant mathsize mathcolor mathbackground accent accentunder columnalign " +
  "columnlines columnspacing rowalign rowlines rowspacing rowspan columnspan depth height width " +
  "linethickness lspace rspace stretchy fence separator symmetric minsize maxsize movablelimits " +
  "notation scriptlevel largeop form open close separators frame longdivstyle position shift length crossout"
).split(" ");

const images: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const rasterMimeByFirstByte: Partial<Record<number, string>> = {
  0x89: images.png,
  0xff: images.jpg,
  0x47: images.gif,
  0x52: images.webp,
};
const imageTypes = new Set([...Object.values(images), "image/svg+xml"]);
const fonts: Record<string, string> = {
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
};
const fontMimeBySignature = new Map([
  ["OTTO", fonts.otf],
  ["\0\x01\0\0", fonts.ttf],
  ["wOFF", fonts.woff],
  ["wOF2", fonts.woff2],
]);
const legacyFonts: Record<string, string> = {
  "application/vnd.ms-opentype": "font/otf",
  "application/font-sfnt": "font/ttf",
  "application/font-woff": "font/woff",
};
const audiovisual: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
};
const xhtmlTypes = new Set(["application/xhtml+xml", "text/html"]);
const tagName = (node: XmlNode) => node.name.replace(/^\{[^}]*\}|^(?:svg|math):/, "");
const attr = (name: string, value: string | undefined) =>
  value === undefined ? "" : ` ${name}="${escape(value)}"`;
const extension = (path: string) => path.split(".").at(-1)?.toLowerCase() ?? "";
const shortTitle = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/[\uD800-\uDBFF]$/, "") || undefined;

async function readXmlText(archive: JSZip, path: string) {
  const bytes = await archive.file(path)?.async("uint8array");
  if (!bytes || bytes.length > 8 * 1024 * 1024) throw new PreviewError({ code: "xml-invalid" });
  try {
    return officeXmlDecoder(bytes).decode(bytes);
  } catch (cause) {
    if (cause instanceof RangeError) throw new PreviewError({ code: "xml-invalid" });
    throw cause;
  }
}

async function readChapter(archive: JSZip, path: string, mime: string): Promise<XmlNode> {
  const source = await readXmlText(archive, path);
  if (mime !== "text/html") {
    try {
      return parseXml(source);
    } catch (cause) {
      if (
        mime !== "application/xhtml+xml" ||
        !isPreviewError(cause) ||
        cause.code !== "xml-invalid"
      )
        throw cause;
    }
  }
  // Some legacy books ship tag soup in XHTML spine items. Recover with the browser's
  // parsing rules, then pass the tree through the same allowlist as a well-formed chapter.
  if (source.length > 2 * 1024 * 1024) throw new PreviewError({ code: "xml-invalid" });
  const { parse, defaultTreeAdapter: tree } = await import("parse5");
  let count = 0;
  function convert(node: import("parse5").DefaultTreeAdapterMap["node"], depth: number): XmlNode[] {
    if (depth > 100) throw new PreviewError({ code: "xml-too-deep" });
    if (++count > 100_000) throw new PreviewError({ code: "xml-too-much-content" });
    if (tree.isTextNode(node))
      return [{ name: "#text", attrs: {}, children: [], text: node.value }];
    if (!tree.isElementNode(node)) return [];
    return [
      {
        name: node.tagName,
        attrs: Object.fromEntries(
          node.attrs.map(({ name, prefix, value }) => [prefix ? `${prefix}:${name}` : name, value]),
        ),
        children: node.childNodes.flatMap((child) => convert(child, depth + 1)),
        text: "",
      },
    ];
  }
  return {
    name: "root",
    attrs: {},
    children: parse(source, { scriptingEnabled: false }).childNodes.flatMap((node) =>
      convert(node, 0),
    ),
    text: "",
  };
}

function localPath(archive: JSZip, base: string, href: string) {
  const path = archivePath(base, href.trim());
  if (path && archive.file(path)) return path;
  const literal = archivePath(base, href.trim().replaceAll("%", "%25"));
  return literal && archive.file(literal) ? literal : null;
}

function dimensions(width: number, height: number) {
  return width >= 1 && height >= 1 && width <= 16_384 && height <= 16_384
    ? { width, height }
    : undefined;
}

function viewport(root: XmlNode) {
  const content = find(root, "meta").find((node) => node.attrs.name === "viewport")?.attrs.content;
  if (!content) return;
  return dimensions(
    Number(/\bwidth\s*=\s*([\d.]+)/i.exec(content)?.[1]),
    Number(/\bheight\s*=\s*([\d.]+)/i.exec(content)?.[1]),
  );
}

function svgViewport(node: XmlNode) {
  const [, , width, height] = (node.attrs.viewBox ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return (
    dimensions(
      Number(node.attrs.width?.replace(/px$/i, "")),
      Number(node.attrs.height?.replace(/px$/i, "")),
    ) ?? dimensions(width ?? 0, height ?? 0)
  );
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

const idpfObfuscation = "http://www.idpf.org/2008/embedding";
const adobeObfuscation = "http://ns.adobe.com/pdf/enc#RC";

export async function openEpub(archive: JSZip) {
  if (archive.file("META-INF/license.lcpl")) throw new PreviewError({ code: "epub-drm" });
  const algorithms = new Map<string, string>();
  const encryption = await optionalXml("META-INF/encryption.xml");
  if (encryption) {
    const ns = "{http://www.w3.org/2001/04/xmlenc#}";
    for (const node of find(encryption, ns + "EncryptedData")) {
      const algorithm = find(node, ns + "EncryptionMethod")[0]?.attrs.Algorithm;
      if (!algorithm) continue;
      if (algorithm !== idpfObfuscation && algorithm !== adobeObfuscation)
        throw new PreviewError({ code: "epub-drm" });
      const uri = find(node, ns + "CipherReference")[0]?.attrs.URI;
      const path = uri && localPath(archive, "", uri);
      if (path) algorithms.set(path, algorithm);
    }
  }
  if (!archive.file("META-INF/container.xml")) throw new PreviewError({ code: "epub-no-package" });
  const container = parseXml(await readXmlText(archive, "META-INF/container.xml"));
  const fullPath = find(container, "rootfile")[0]?.attrs["full-path"] ?? "";
  const rootfile = localPath(archive, "", fullPath);
  if (!rootfile) throw new PreviewError({ code: "epub-no-package" });
  const packageRoot = parseXml(await readXmlText(archive, rootfile));
  const pkg = find(packageRoot, "package")[0];
  const spine = find(packageRoot, "spine")[0];
  const refs = spine ? find(spine, "itemref") : [];
  if (!refs.length || refs.length > 4096) throw new PreviewError({ code: "epub-chapter-count" });

  const manifest = new Map(find(packageRoot, "item").map((item) => [item.attrs.id, item.attrs]));
  const media = new Map<string, string>();
  const spineSources = new Map<string, { path: string; mime: string } | null>();
  for (const [id, item] of manifest) {
    const path = localPath(archive, rootfile, item.href ?? "");
    const mime = item["media-type"];
    if (path && mime) {
      media.set(path, mime);
      if (
        id &&
        (xhtmlTypes.has(mime) || mime === "image/svg+xml" || Object.values(images).includes(mime))
      )
        spineSources.set(id, { path, mime });
    }
  }
  function resolveSpineSource(id: string | undefined) {
    const visited = new Set<string>();
    let source = null;
    while (id && !visited.has(id)) {
      const cached = spineSources.get(id);
      if (cached !== undefined) {
        source = cached;
        break;
      }
      visited.add(id);
      id = manifest.get(id)?.fallback;
    }
    for (const id of visited) spineSources.set(id, source);
    return source;
  }
  const layout = find(packageRoot, "meta").find(
    (node) => node.attrs.property === "rendition:layout",
  );
  const fixed = layout ? text(layout).trim() === "pre-paginated" : false;
  const chapters = refs.flatMap(({ attrs }) => {
    const source = resolveSpineSource(attrs.idref);
    if (!source) return [];
    const properties = attrs.properties?.split(/\s+/) ?? [];
    return [
      {
        ...source,
        linear: attrs.linear !== "no",
        fixed:
          !properties.includes("rendition:layout-reflowable") &&
          (fixed || properties.includes("rendition:layout-pre-paginated")),
      },
    ];
  });
  if (!chapters.length) throw new PreviewError({ code: "epub-no-chapters" });

  const guide = find(packageRoot, "guide")[0];
  const coverReference =
    guide && find(guide, "reference").find((node) => node.attrs.type === "cover");
  const coverPath = coverReference && localPath(archive, rootfile, coverReference.attrs.href ?? "");

  const chapterIndex = new Map<string, number>();
  for (const [index, chapter] of chapters.entries())
    if (!chapterIndex.has(chapter.path)) chapterIndex.set(chapter.path, index);
  function resolve(base: string, href: string): EpubLocation | undefined {
    const [path, fragment] = href.trim().split(/#(.*)/s);
    const target = path ? localPath(archive, base, path) : base;
    const index = target ? chapterIndex.get(target) : undefined;
    if (index === undefined) return;
    let anchor = fragment;
    if (anchor) {
      try {
        anchor = decodeURIComponent(anchor);
      } catch {
        // Some books use unescaped percent signs in IDs.
      }
    }
    return { index, ...(anchor ? { anchor } : {}) };
  }

  const chapterTitles: (string | undefined)[] = Array.from({ length: chapters.length });
  const contents = new Map<string, EpubLocation & { title: string }>();
  function addContents(base: string, href: string | undefined, label: XmlNode | undefined) {
    const location = href && resolve(base, href);
    const title = label && shortTitle(text(label));
    if (!location || !title) return;
    const key = `${location.index}:${location.anchor ?? ""}`;
    if (contents.size < 4096 && !contents.has(key)) contents.set(key, { ...location, title });
    chapterTitles[location.index] ??= title;
  }
  const nav = [...manifest.values()].find((item) => item.properties?.split(/\s+/).includes("nav"));
  const ncx = spine?.attrs.toc ? manifest.get(spine.attrs.toc) : undefined;
  for (const item of [nav, ncx]) {
    const path = item && localPath(archive, rootfile, item.href ?? "");
    if (!path) continue;
    const navPath = path;
    const root = await optionalXml(navPath);
    if (!root) continue;
    if (item === nav) {
      const toc = find(root, "nav").find((node) =>
        node.attrs["epub:type"]?.split(/\s+/).includes("toc"),
      );
      if (toc) for (const link of find(toc, "a")) addContents(path, link.attrs.href, link);
    } else {
      function walk(node: XmlNode) {
        if (node.name === "navPoint")
          addContents(
            navPath,
            node.children.find((child) => child.name === "content")?.attrs.src,
            node.children.find((child) => child.name === "navLabel"),
          );
        for (const child of node.children) walk(child);
      }
      const toc = find(root, "navMap")[0];
      if (toc) walk(toc);
    }
    if (contents.size) break;
  }

  async function optionalXml(path: string) {
    if (!archive.file(path)) return;
    try {
      return parseXml(await readXmlText(archive, path));
    } catch (cause) {
      if (!isPreviewError(cause)) throw cause;
    }
  }
  const identifier = find(packageRoot, "identifier").find(
    (node) => node.attrs.id === pkg?.attrs["unique-identifier"],
  );
  // DC elements use an expanded namespace in the shared XML parser.
  const dcIdentifier =
    pkg &&
    find(pkg, "metadata")[0]?.children.find(
      (node) =>
        node.name === "{http://purl.org/dc/elements/1.1/}identifier" &&
        node.attrs.id === pkg.attrs["unique-identifier"],
    );
  const id = identifier ?? dcIdentifier;
  const bookId = id ? text(id).replace(/[\t\n\r ]/g, "") : "";
  const idpfKey = bookId ? sha1(new TextEncoder().encode(bookId)) : undefined;
  const uuid = /^(?:urn:uuid:)?([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i.exec(
    bookId,
  )?.[1];
  const adobeKey = uuid
    ? Uint8Array.from(uuid.replaceAll("-", "").match(/../g)!, (byte) => parseInt(byte, 16))
    : undefined;

  async function page(index: number): Promise<EpubPage & { assets: string[] }> {
    const chapter = chapters[index];
    if (!chapter) throw new PreviewError({ code: "epub-no-chapters" });
    const { path, mime, fixed } = chapter;
    let markupSize = 0;
    let resourceSize = 0;
    let resourceCount = 0;
    let svgDepth = 0;
    const resources = new Map<string, string>();
    const assets: string[] = [];
    let imagePageSize: EpubPage["fixed"];
    let linkBase: string | undefined;

    function asset(bytes: Uint8Array<ArrayBuffer>, mime: string) {
      if (resourceSize + bytes.length > 32 * 1024 * 1024) return "";
      resourceSize += bytes.length;
      // SVG images need self-contained assets. The desktop font policy also allows data fonts.
      if (svgDepth || mime.startsWith("font/")) return `data:${mime};base64,${toBase64(bytes)}`;
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      assets.push(url);
      return url;
    }
    function bounded(value: string) {
      markupSize += value.length;
      if (markupSize > 48 * 1024 * 1024) throw new PreviewError({ code: "rendered-too-large" });
      return value;
    }

    function embeddedAsset(source: string, kind: "raster" | "font"): string {
      const header = /^data:([\w.+-]+\/[\w.+-]+)?;base64,/i.exec(source);
      if (!header) return "";
      const declared = header[1]?.toLowerCase();
      const expectedMime =
        declared && (Object.hasOwn(legacyFonts, declared) ? legacyFonts[declared] : declared);
      if (expectedMime && !Object.values(kind === "font" ? fonts : images).includes(expectedMime))
        return "";
      const cacheKey = `${kind}:${svgDepth ? "embedded:" : "blob:"}${source}`;
      const existing = resources.get(cacheKey);
      if (existing !== undefined) return existing;
      if (++resourceCount > 2048) return "";
      resources.set(cacheKey, "");
      const maxBytes = Math.min(
        (kind === "font" ? 24 : 8) * 1024 * 1024,
        32 * 1024 * 1024 - resourceSize,
      );
      const base64 = source.slice(header[0].length).replace(/[\t\n\f\r ]/g, "");
      if (base64.length > Math.ceil(maxBytes / 3) * 4) return "";
      let decoded: string;
      try {
        decoded = atob(base64);
      } catch {
        return "";
      }
      if (decoded.length > maxBytes) return "";
      const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
      let mime: string | undefined;
      if (kind === "font" && decoded.length >= 12)
        mime = fontMimeBySignature.get(decoded.slice(0, 4));
      else if (kind === "raster" && previewImageSize(bytes))
        mime = rasterMimeByFirstByte[bytes[0]!];
      if (!mime || (expectedMime && expectedMime !== mime)) return "";
      const url = asset(bytes, mime);
      resources.set(cacheKey, url);
      return url;
    }

    async function resource(target: string | null): Promise<string> {
      if (!target) return "";
      const cacheKey = `${svgDepth ? "embedded:" : "blob:"}${target}`;
      const existing = resources.get(cacheKey);
      if (existing !== undefined) return existing;
      if (++resourceCount > 2048 || resourceSize >= 32 * 1024 * 1024) return "";
      // Mark the resource before descending into an SVG so references cannot cycle.
      resources.set(cacheKey, "");
      const ext = extension(target);
      const imageType = Object.hasOwn(images, ext) ? images[ext] : undefined;
      const fontType = Object.hasOwn(fonts, ext) ? fonts[ext] : undefined;
      const type = media.get(target);
      if (ext === "svg" || type === "image/svg+xml") {
        if (svgDepth >= 8) return "";
        const svg = (await optionalXml(target))?.children.find((node) => tagName(node) === "svg");
        if (!svg) return "";
        svgDepth++;
        let markup = await render(svg, target);
        let css = "";
        for (const style of find(svg, "svg:style")) {
          const source = text(style).replace(/^\uFEFF/, "");
          if (source.length <= 256 * 1024)
            css += `<style${attr("media", style.attrs.media)}>${escape(await cssUrls(source, target))}</style>`;
        }
        svgDepth--;
        if (css) markup = `${markup.slice(0, -6)}${css}</svg>`;
        const url = asset(new TextEncoder().encode(markup), "image/svg+xml");
        resources.set(cacheKey, url);
        return url;
      }
      const raster = type && Object.values(images).includes(type) ? type : imageType;
      const font =
        (type && Object.hasOwn(legacyFonts, type) ? legacyFonts[type] : undefined) ??
        (type && Object.values(fonts).includes(type) ? type : fontType);
      const playback =
        type && Object.values(audiovisual).includes(type)
          ? type
          : Object.hasOwn(audiovisual, ext)
            ? audiovisual[ext]
            : undefined;
      const mimeType = raster ?? font ?? playback;
      const entry = mimeType && archive.file(target);
      if (!entry) return "";
      const bytes = new Uint8Array(await entry.async("arraybuffer"));
      if (bytes.length > (raster ? 8 : 24) * 1024 * 1024) return "";
      if (raster) {
        const size = previewImageSize(bytes);
        if (!size) return "";
        if (target === path) imagePageSize = dimensions(size.width, size.height);
      }
      const algorithm = algorithms.get(target);
      if (algorithm) {
        const key =
          algorithm === idpfObfuscation
            ? idpfKey
            : algorithm === adobeObfuscation
              ? adobeKey
              : undefined;
        if (!font || !key) return "";
        const length = Math.min(bytes.length, key === idpfKey ? 1040 : 1024);
        for (let i = 0; i < length; i++) bytes[i] = bytes[i]! ^ key[i % key.length]!;
      }
      const url = asset(bytes, mimeType);
      resources.set(cacheKey, url);
      return url;
    }

    async function cssUrls(css: string, base: string) {
      let result = "";
      let end = 0;
      for (const match of css.matchAll(
        /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi,
      )) {
        const href = match[1] ?? match[2] ?? match[3];
        if (href === undefined || href.startsWith("#")) continue;
        const data = /^data:/i.test(href)
          ? embeddedAsset(
              href.replace(/\\(?:\r\n|[\r\n\f])/g, ""),
              /^data:image\//i.test(href) ? "raster" : "font",
            )
          : await resource(localPath(archive, base, href));
        result += bounded(
          css.slice(end, match.index) + (data ? `url("${data}")` : "url(about:blank)"),
        );
        end = match.index + match[0].length;
      }
      return result + bounded(css.slice(end));
    }

    const styles: { css: string; media: string }[] = [];
    const stylePaths = new Set<string>();
    let styleBytes = 0;
    async function addStyle(css: string, base: string, query = "", depth = 0): Promise<void> {
      styleBytes += css.length;
      if (depth >= 8 || styleBytes > 1024 * 1024 || styles.length >= 64) return;
      css = css.replace(/^\uFEFF/, "").replace(/^\s*@charset\s+["'][^"']+["']\s*;/i, "");
      const prelude =
        /^\s*(?:\/\*[\s\S]*?\*\/\s*)*@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s;)]+))\s*\)?\s*([^;]*);/i;
      for (let match = prelude.exec(css); match; match = prelude.exec(css)) {
        css = css.slice(match[0].length);
        const target = localPath(archive, base, match[1] ?? match[2] ?? match[3] ?? "");
        const condition = match[4]?.trim() ?? "";
        if (target && !stylePaths.has(target)) {
          stylePaths.add(target);
          const imported = await archive.file(target)!.async("string");
          await addStyle(
            imported,
            target,
            query && condition ? `${query} and ${condition}` : condition || query,
            depth + 1,
          );
          stylePaths.delete(target);
        }
      }
      if (css.trim())
        styles.push({
          css: (await cssUrls(css, base))
            .replaceAll(/\bepub\|type\b/g, "epub\\:type")
            .replaceAll(/<(?=\/style)/gi, "\\3c "),
          media: query,
        });
    }

    async function attributes(node: XmlNode, attrs: readonly string[], base: string) {
      let result = commonAttrs.map((key) => attr(key, node.attrs[key])).join("");
      if (!node.attrs.lang) result += attr("lang", node.attrs["xml:lang"]);
      for (const key of attrs) {
        if (commonAttrs.includes(key)) continue;
        const value = node.attrs[key];
        if (value === undefined) continue;
        result += attr(key, value.includes("url(") ? await cssUrls(value, base) : value);
      }
      if (node.attrs.style) result += attr("style", await cssUrls(node.attrs.style, base));
      return result;
    }

    async function render(
      node: XmlNode,
      base: string,
      mode?: "svg" | "math",
      insideLink = false,
    ): Promise<string> {
      if (node.name === "#text") return bounded(escape(node.text));
      const tag = tagName(node);
      if (omitted.has(tag)) return "";
      const namespace = tag === "svg" ? "svg" : tag === "math" ? "math" : mode;
      const formTag = namespace === undefined && formTags.has(tag);
      if (tag === "object" && namespace === undefined) {
        const target = localPath(archive, base, node.attrs.data ?? "");
        const type = node.attrs.type?.trim().toLowerCase();
        const ext = target ? extension(target) : "";
        const imageObject =
          target &&
          (!type || imageTypes.has(type)) &&
          (ext === "svg" || Object.hasOwn(images, ext) || imageTypes.has(media.get(target) ?? ""));
        const src = imageObject ? await resource(target) : "";
        if (src) {
          // Images use the sanitized image path. Other objects keep their authored fallback.
          const props = await attributes(node, htmlAttrs, base);
          const alt = node.attrs.alt === undefined ? attr("alt", shortTitle(text(node)) ?? "") : "";
          return bounded(`<img${props}${alt}${attr("src", src)}>`);
        }
      }
      const allowed =
        namespace === "svg"
          ? svgTags.has(tag)
          : namespace === "math"
            ? mathTags.has(tag)
            : formTag || htmlTags.has(tag) || voidTags.has(tag);
      let props = allowed
        ? await attributes(
            node,
            namespace === "svg"
              ? svgAttrs
              : namespace === "math"
                ? mathAttrs
                : formTag
                  ? formAttrs
                  : htmlAttrs,
            base,
          )
        : "";
      if (formTag && staticControls.has(tag) && node.attrs.disabled === undefined)
        props += " disabled";
      if (tag === "svg")
        props += ' xmlns="http://www.w3.org/2000/svg"' + attr("xml:space", node.attrs["xml:space"]);
      if (tag === "math") props += ' xmlns="http://www.w3.org/1998/Math/MathML"';
      if (tag === "table" && node.children.some((child) => tagName(child) === "tr"))
        props += ' data-epub-direct-rows=""';
      if (tag === "tbody") props += ' data-epub-authored=""';
      const imageControl = formTag && tag === "input" && node.attrs.type?.toLowerCase() === "image";
      const svgImage = namespace === "svg" && tag === "image";
      if (tag === "img" || imageControl || svgImage) {
        const source = (node.attrs.src ?? node.attrs.href ?? node.attrs["xlink:href"] ?? "").trim();
        const src = /^data:/i.test(source)
          ? embeddedAsset(source, "raster")
          : await resource(localPath(archive, base, source));
        if (!src && !imageControl)
          return tag === "img" ? bounded(escape(node.attrs.alt ?? "")) : "";
        if (src) props += attr(svgImage ? "href" : "src", src);
      }
      if (
        namespace === "svg" &&
        ["use", "textPath", "linearGradient", "radialGradient", "pattern"].includes(tag)
      ) {
        const href = node.attrs.href ?? node.attrs["xlink:href"];
        if (href?.startsWith("#")) props += attr("href", href);
      }
      if (namespace === undefined && (tag === "video" || tag === "audio" || tag === "source")) {
        const src = await resource(localPath(archive, base, node.attrs.src ?? ""));
        if (tag === "source" && !src) return "";
        if (src) props += attr("src", src);
        if (tag !== "source") props += " controls" + attr("preload", node.attrs.preload);
        if (tag === "video") {
          const poster = await resource(localPath(archive, base, node.attrs.poster ?? ""));
          if (poster) props += attr("poster", poster);
        }
      }
      if (tag === "a") {
        const href = node.attrs.href ?? node.attrs["xlink:href"];
        const target = href && linkBase && base === path ? parseUrl(href, linkBase)?.href : href;
        const location = target ? resolve(base, target) : undefined;
        const external = target && !location ? externalUrl(target) : undefined;
        if (location)
          props +=
            ' href="#"' +
            attr("data-epub-index", String(location.index)) +
            attr("data-epub-anchor", location.anchor);
        else if (external) props += ' href="#"' + attr("data-epub-external", external);
        else if (href && (/^ftp:\/\//i.test(href) || !/^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(href)))
          props += ' href="#" aria-disabled="true" tabindex="-1"';
      }
      if (namespace === undefined && voidTags.has(tag)) return bounded(`<${tag}${props}>`);
      const htmlLink = namespace === undefined && tag === "a";
      let children = "";
      for (const child of node.children)
        children += await render(child, base, namespace, insideLink || htmlLink);
      if (!allowed) return children;
      const element = htmlLink && insideLink ? "epub-nested-link" : tag;
      // The HTML parser removes a leading line break that XHTML keeps.
      const lineBreak =
        (tag === "pre" || tag === "textarea") && /^[\r\n]/.test(children) ? "\n" : "";
      bounded(`<${element}${props}>${lineBreak}</${element}>`);
      return `<${element}${props}>${lineBreak}${children}</${element}>`;
    }

    async function renderPage(): Promise<EpubPage> {
      if (!xhtmlTypes.has(mime) && mime !== "image/svg+xml") {
        const data = await resource(path);
        if (!data) throw new PreviewError({ code: "epub-no-chapters" });
        return { html: `<img src="${data}" alt="">`, imagePage: true, fixed: imagePageSize };
      }
      const root = await readChapter(archive, path, mime);
      if (mime === "image/svg+xml") {
        const svg = root.children.find((node) => tagName(node) === "svg");
        if (!svg) throw new PreviewError({ code: "xml-invalid" });
        for (const instruction of root.children) {
          if (instruction.name !== "?xml-stylesheet") continue;
          const target = localPath(archive, path, instruction.attrs.href ?? "");
          if (target)
            await addStyle(
              await archive.file(target)!.async("string"),
              target,
              instruction.attrs.media,
            );
        }
        for (const node of find(svg, "svg:style"))
          await addStyle(text(node), path, node.attrs.media);
        const label = find(svg, "svg:title")[0];
        const size = svgViewport(svg);
        return {
          html: await render(svg, path),
          title: label && shortTitle(text(label)),
          styles,
          fixed: size,
          imagePage: true,
        };
      }
      const html = find(root, "html")[0];
      const head = html?.children.find((node) => node.name === "head");
      const body = html?.children.find((node) => node.name === "body");
      if (head) {
        const base = head.children.find(
          (node) => node.name === "base" && node.attrs.href !== undefined,
        )?.attrs.href;
        const url = base ? parseUrl(base) : null;
        if (url?.protocol === "http:" || url?.protocol === "https:") linkBase = url.href;
        for (const node of head.children) {
          const rel = node.attrs.rel?.toLowerCase().split(/\s+/) ?? [];
          if (node.name === "link" && rel.includes("stylesheet") && !rel.includes("alternate")) {
            const target = localPath(archive, path, node.attrs.href ?? "");
            if (target)
              await addStyle(await archive.file(target)!.async("string"), target, node.attrs.media);
          } else if (node.name === "style") await addStyle(text(node), path, node.attrs.media);
        }
      }
      // XHTML producers also place styles in the body. Keep the cascade in source order.
      if (body)
        for (const node of find(body, "style")) await addStyle(text(node), path, node.attrs.media);
      const title = [...(head ? find(head, "title") : []), ...find(body ?? root, "h1")]
        .map((heading) => shortTitle(text(heading)))
        .find(Boolean);
      const content = body ?? html ?? root;
      let markup = "";
      for (const node of content.children) markup += await render(node, path);
      const cover = path === coverPath || body?.attrs["epub:type"]?.split(/\s+/).includes("cover");
      const coverSvg = cover && body && find(body, "svg:svg")[0];
      const authoredSize = fixed ? viewport(root) : undefined;
      const imageSize = !authoredSize && coverSvg ? svgViewport(coverSvg) : undefined;
      return {
        html: markup,
        title,
        styles,
        htmlAttrs: html ? bounded(await attributes(html, [], path)) : undefined,
        bodyAttrs: body ? bounded(await attributes(body, [], path)) : undefined,
        fixed: authoredSize ?? imageSize,
      };
    }
    try {
      return { ...(await renderPage()), assets };
    } catch (cause) {
      for (const url of assets) URL.revokeObjectURL(url);
      throw cause;
    }
  }

  const first = chapters.findIndex((chapter) => chapter.linear);
  return {
    first: Math.max(0, first),
    rtl: spine?.attrs["page-progression-direction"] === "rtl",
    chapters: chapters.map((chapter, index) => ({
      title: chapterTitles[index],
      linear: chapter.linear,
    })),
    contents: [...contents.values()],
    page,
  };
}
