import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { decodeHTMLStrict as decodeEntities } from "entities";
import { PreviewError } from "./previewFailure";

// `text` and `attrs` hold decoded values: escaped text is decoded once, CDATA stays literal.
export type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
};
type OrderedXml = { [key: string]: OrderedXml[] | Record<string, string> | string };
export const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const namespacePrefixes: Record<string, string> = {
  "urn:oasis:names:tc:opendocument:xmlns:office:1.0": "office",
  "urn:oasis:names:tc:opendocument:xmlns:table:1.0": "table",
  "urn:oasis:names:tc:opendocument:xmlns:text:1.0": "text",
  "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0": "draw",
  "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0": "svg",
  "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0": "presentation",
  "http://www.w3.org/1999/xlink": "xlink",
  "http://www.w3.org/1999/xhtml": "",
  "http://www.idpf.org/2007/opf": "",
  "http://www.daisy.org/z3986/2005/ncx/": "",
  "http://www.w3.org/2000/svg": "svg",
  "http://www.w3.org/1998/Math/MathML": "math",
  "http://www.w3.org/ns/SMIL": "smil",
  "http://www.w3.org/ns/ttml": "ttml",
  "http://www.w3.org/2006/04/ttaf1": "ttml",
  "http://www.idpf.org/2007/ops": "epub",
  "http://www.w3.org/XML/1998/namespace": "xml",
  "urn:oasis:names:tc:opendocument:xmlns:container": "",
};
export function parseXml(source: string): XmlNode {
  // EPUB XHTML commonly declares an external DTD: discard it without resolving it. Any other
  // declaration is rejected; CDATA, comments and processing instructions pass through untouched.
  let declares = false;
  source = source.replaceAll(
    /<\?[\s\S]*?(?:\?>|$)|<!\[CDATA\[[\s\S]*?(?:]]>|$)|<!--[\s\S]*?(?:-->|$)|(<!DOCTYPE\s+[^<>[\]]*(?:\[\s*\]\s*)?>)|(<!\s*(?:DOCTYPE|ENTITY))/gi,
    (markup, externalDoctype?: string, declaration?: string) => {
      if (declaration) declares = true;
      return externalDoctype ? " " : markup;
    },
  );
  if (source.length > 8 * 1024 * 1024 || declares || XMLValidator.validate(source) !== true)
    throw new PreviewError({ code: "xml-invalid" });
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "",
    processEntities: false,
    trimValues: false,
    parseTagValue: false,
    cdataPropName: "#cdata",
  });
  let ordered: OrderedXml[];
  try {
    ordered = parser.parse(source) as OrderedXml[];
  } catch (cause) {
    if (cause instanceof Error && cause.message === "Maximum nested tags exceeded")
      throw new PreviewError({ code: "xml-too-deep" });
    throw cause;
  }
  let count = 0;
  function convert(
    items: OrderedXml[],
    depth: number,
    inherited: Record<string, string>,
  ): XmlNode[] {
    if (depth > 100) throw new PreviewError({ code: "xml-too-deep" });
    return items.map((item) => {
      if (++count > 100_000) throw new PreviewError({ code: "xml-too-much-content" });
      const name = Object.keys(item).find((key) => key !== ":@") ?? "#text";
      const value = item[name];
      if (name === "#cdata") {
        const literal = Array.isArray(value)
          ? value.map((part) => part["#text"] ?? "").join("")
          : "";
        return { name: "#text", attrs: {}, children: [], text: literal };
      }
      const attrs = Object.fromEntries(
        Object.entries((item[":@"] ?? {}) as Record<string, string>).map(([key, value]) => {
          // fast-xml-parser accepts raw '<' in element attributes, which can mask declarations
          // above. Processing instructions end at their first '?>', so their data may hold '<'.
          if (!name.startsWith("?") && value.includes("<"))
            throw new PreviewError({ code: "xml-invalid" });
          return [key, decodeEntities(value)];
        }),
      );
      const namespaces = Object.create(inherited) as Record<string, string>;
      for (const [key, value] of Object.entries(attrs)) {
        if (key === "xmlns") namespaces[""] = value;
        else if (key.startsWith("xmlns:")) namespaces[key.slice(6)] = value;
      }
      const expanded = (name: string, attribute = false) => {
        if (name.startsWith("#")) return name;
        const colon = name.indexOf(":");
        if (colon < 0 && attribute) return name;
        const uri = namespaces[colon < 0 ? "" : name.slice(0, colon)];
        if (!uri) return name;
        const prefix = Object.hasOwn(namespacePrefixes, uri) ? namespacePrefixes[uri] : undefined;
        const local = name.slice(colon + 1);
        return prefix === undefined
          ? "{" + uri + "}" + local
          : prefix
            ? prefix + ":" + local
            : local;
      };
      return {
        name: expanded(name),
        attrs: Object.fromEntries(
          Object.entries(attrs).map(([key, value]) => [expanded(key, true), value]),
        ),
        children: Array.isArray(value) ? convert(value, depth + 1, namespaces) : [],
        text: typeof value === "string" ? decodeEntities(value) : "",
      };
    });
  }
  return {
    name: "root",
    attrs: {},
    children: convert(ordered, 0, Object.create(null) as Record<string, string>),
    text: "",
  };
}
export function find(node: XmlNode, name: string, skip?: string): XmlNode[] {
  return node.children.flatMap((child) =>
    child.name === skip
      ? []
      : child.name === name || (!name.includes(":") && child.name.endsWith(`:${name}`))
        ? [child]
        : find(child, name, skip),
  );
}
export function text(node: XmlNode): string {
  if (node.name === "office:annotation") return "";
  if (node.name === "text:s") return " ".repeat(repeat(node.attrs["text:c"], 100));
  if (node.name === "text:tab") return "\t";
  if (node.name === "text:line-break") return "\n";
  return node.name === "#text" ? node.text : node.children.map(text).join("");
}
export function archivePath(base: string, href: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(href)) return null;
  const parts = base.split("/").slice(0, -1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? "");
  } catch {
    return null;
  }
  for (const part of decoded.split("/")) {
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
export function previewImageSize(bytes: Uint8Array) {
  const size = readImageDimensions(bytes);
  return size && size.width <= 16_777_216 / size.height ? size : null;
}

export function imageFits(bytes: Uint8Array) {
  return previewImageSize(bytes.subarray(0, IMAGE_DIMENSIONS_HEADER_BYTES)) !== null;
}

export function repeat(value: string | undefined, max: number) {
  const count = Number(value ?? 1);
  if (!Number.isSafeInteger(count) || count < 1)
    throw new PreviewError({ code: "repeated-content-invalid" });
  return Math.min(count, max);
}
