import { WORD_DISABLED_PARTS, WORD_EXPANDED_PARTS, boundWorkbook, officeXml, officeXmlDecoder, wordDocuments, wordPartTypes, wordSections, xmlParser } from "./officeArchive-02-xml.ts";
import JSZip from "jszip";
import { checkZipDirectory } from "@t3tools/client-runtime/zip/directory";
import {
  OFFICE_PREVIEW_MAX_BYTES,
  OFFICE_PREVIEW_MAX_COLUMNS,
  OFFICE_PREVIEW_MAX_ROWS,
  type OfficeWorkerRequest,
} from "./officePreviewProtocol";

export const WORD_STYLE_MAX_BYTES = 1024 * 1024;
export const WORD_STYLE_MAX_UNITS = 20_000;

export function wordXmlCost(xml: string, roles: Set<string> | undefined) {
  const parser = xmlParser();
  let depth = 0;
  let markup = 0;
  const limit = Symbol("Word style budget");
  const exceeded = { bytes: Infinity, markup: Infinity, pictures: false };
  let styleCount = 0;
  let ownUnits = 0;
  const styles = new Map<
    string,
    { properties: Map<string, number>; base: string; linked: string }
  >();
  let style: { id: string; base: string; linked: string; properties: Map<string, number> } | null =
    null;
  const names: string[] = [];
  const definitions = new Map<string, { bytes: number; markup: number }>();
  const references: { id: string; selector: number }[] = [];
  let definition: { id: string; start: number; markup: number } | null = null;
  let reference: { id: string; selector: number } | null = null;
  let pictures = false;
  parser.on("opentag", (tag) => {
    if (++depth > 64)
      throw new Error("Preview limited: this Word document has excessive XML nesting.");
    markup++;
    const attr = (name: string) =>
      Object.values(tag.attributes).find((a) => a.local === name)?.value ?? "";
    names.push(tag.local === "tblStylePr" ? `${tag.local}:${attr("type")}` : tag.local);
    if (roles?.has("styles") && (tag.local === "style" || tag.local === "docDefaults")) {
      if (++styleCount > 1_024 || attr("styleId").length > 256) throw limit;
      style = { id: attr("styleId"), properties: new Map(), base: "", linked: "" };
    }
    if (style) {
      if (tag.local === "basedOn") style.base = attr("val");
      else if (tag.local === "link") style.linked = attr("val");
      else if (names.length > 2 && tag.local !== "name") {
        const key = names.slice(2).join("/");
        const size = new TextEncoder().encode(
          xml.slice(xml.lastIndexOf("<", parser.position - 1), parser.position),
        ).length;
        if (++ownUnits > WORD_STYLE_MAX_UNITS) throw limit;
        style.properties.set(key, size);
      }
    }
    if (roles?.has("numbering")) {
      if (tag.local === "abstractNum")
        definition = {
          id: attr("abstractNumId"),
          start: xml.lastIndexOf("<", parser.position - 1),
          markup: markup - 1,
        };
      if (tag.local === "num") {
        if (references.length >= 2_000) throw limit;
        reference = { id: "", selector: attr("numId").length + 32 };
        references.push(reference);
      }
      if (tag.local === "abstractNumId" && reference) reference.id = attr("val");
    }
    if (tag.local === "numPicBullet") pictures = true;
  });
  parser.on("closetag", (tag) => {
    if (definition && tag.local === "abstractNum") {
      const previous = definitions.get(definition.id);
      definitions.set(definition.id, {
        bytes:
          (previous?.bytes ?? 0) +
          new TextEncoder().encode(xml.slice(definition.start, parser.position)).length,
        markup: (previous?.markup ?? 0) + markup - definition.markup,
      });
      definition = null;
    }
    if (tag.local === "num") reference = null;
    if (style && (tag.local === "style" || tag.local === "docDefaults")) {
      styles.set(style.id, style);
      style = null;
    }
    names.pop();
    depth--;
  });
  try {
    parser.write(xml).close();
  } catch (cause) {
    if (cause !== limit) throw cause;
    return exceeded;
  }
  const rawBytes = new TextEncoder().encode(xml).length;
  if (roles?.has("styles")) {
    // Immutable parent pointers match processStyles' ordered merges (including
    // forward links and cycles) without copying an expanding property map.
    type Resolved = {
      properties: Map<string, number>;
      parent?: Resolved | undefined;
      depth: number;
    };
    const resolved = new Map<string, Resolved>();
    for (const [id, style] of styles) resolved.set(id, { properties: style.properties, depth: 1 });
    for (const [id, style] of styles) {
      const parent = style.base ? resolved.get(style.base) : undefined;
      if (parent && parent.depth >= 32) return exceeded;
      resolved.set(id, { properties: style.properties, parent, depth: (parent?.depth ?? 0) + 1 });
    }
    let bytes = 0;
    let expandedMarkup = 0;
    let visited = 0;
    let propertyVisits = 0;
    for (const [id, style] of styles) {
      for (const root of [
        resolved.get(id),
        style.linked ? resolved.get(style.linked) : undefined,
      ]) {
        const seen = new Set<string>();
        for (let node = root; node; node = node.parent) {
          if (++visited > 8_192) return exceeded;
          for (const [key, size] of node.properties) {
            if (++propertyVisits > 100_000) return exceeded;
            if (seen.has(key)) continue;
            // Latent styles never enter properties. Charge each own property
            // once per resolved style, including linked and default selectors.
            const copies = id ? 1 : 2;
            bytes += (size * 2 + id.length + 32) * copies;
            expandedMarkup += copies;
            if (bytes > WORD_STYLE_MAX_BYTES || expandedMarkup > WORD_STYLE_MAX_UNITS)
              return exceeded;
            seen.add(key);
          }
        }
      }
    }
    return { bytes, markup: expandedMarkup, pictures };
  }
  let bytes = rawBytes;
  if (roles?.has("numbering")) {
    for (const ref of references) {
      const cost = definitions.get(ref.id);
      if (!cost) continue;
      bytes += cost.bytes * 2 + cost.markup * ref.selector;
      markup += cost.markup;
      if (bytes > 128 * 1024 || markup > 2_000) return exceeded;
    }
  }
  return { bytes, markup, pictures };
}

// Layout can repeat notes at references and headers/footers across pages.
// Charge those copies, not just the XML that defines them.
export async function wordExpansion(
  archive: JSZip,
  parts: ReturnType<typeof wordPartTypes>,
  mediaSizes: Map<string, number>,
  auxiliaryCosts: Map<string, { bytes: number; markup: number }>,
  documents: string[],
) {
  type Cost = { bytes: number; markup: number; media: number; images: Set<string> };
  const empty = (): Cost => ({ bytes: 0, markup: 0, media: 0, images: new Set() });
  const nodes = new Map<string, { xml: string; path: string }>();
  const optional = new Set<string>();
  const noteParts = new Map<string, string>();
  for (const [path, roles] of parts.roles) {
    if (![...roles].some((role) => WORD_EXPANDED_PARTS.has(role))) continue;
    const xml = await archive.file(path)?.async("string");
    if (!xml) continue;
    optional.add(path);
    if (roles.has("header") || roles.has("footer")) nodes.set(path, { xml, path });
    for (const role of ["footnotes", "endnotes", "comments"]) {
      if (!roles.has(role)) continue;
      noteParts.set(role.slice(0, -1), path);
      const parser = xmlParser();
      let start = 0;
      let id = "";
      let depth = 0;
      let prefix = "";
      let suffix = "";
      parser.on("opentag", (tag) => {
        if (++depth === 1) {
          prefix = xml.slice(0, parser.position);
          suffix = `</${tag.name}>`;
        }
        if (tag.local !== role.slice(0, -1)) return;
        start = xml.lastIndexOf("<", parser.position - 1);
        id = Object.values(tag.attributes).find((attr) => attr.local === "id")?.value ?? "";
      });
      parser.on("closetag", (tag) => {
        if (tag.local === role.slice(0, -1))
          nodes.set(`${path}#${id}`, {
            xml: prefix + xml.slice(start, parser.position) + suffix,
            path,
          });
        depth--;
      });
      parser.write(xml).close();
    }
  }
  const used = new Set<string>();
  const memo = new Map<string, Cost>();
  let expandedXmlBytes = 0;
  const scan = (xml: string, path: string, chain: Set<string>, pages = 1, expand = true): Cost => {
    const cost = empty();
    const refs = new Map<string, number>();
    const headers = new Set<string>();
    const parser = xmlParser();
    const add = (key: string) => refs.set(key, (refs.get(key) ?? 0) + 1);
    parser.on("opentag", (tag) => {
      const attr = (name: string) =>
        Object.values(tag.attributes).find((a) => a.local === name)?.value ?? "";
      const note = /^(footnote|endnote|comment)Reference$/.exec(tag.local)?.[1];
      if (note && noteParts.has(note)) add(`${noteParts.get(note)}#${attr("id")}`);
      if (tag.local === "headerReference" || tag.local === "footerReference") {
        const target = parts.relationships.get(path)?.get(attr("id"));
        if (target) headers.add(target);
      }
      if (tag.local === "altChunk") cost.bytes = Infinity;
      if (tag.local !== "blip" && tag.local !== "imagedata") return;
      const target = parts.relationships.get(path)?.get(attr("embed") || attr("id"));
      if (target) {
        cost.media += mediaSizes.get(target) ?? OFFICE_PREVIEW_MAX_BYTES + 1;
        cost.images.add(target);
      }
    });
    parser.write(xml).close();
    for (const header of headers) refs.set(header, pages);
    if (!expand) return cost;
    for (const [key, copies] of refs) {
      const node = nodes.get(key);
      if (!node) continue;
      used.add(node.path);
      if (chain.has(key) || chain.size >= 64) {
        cost.bytes = Infinity;
        break;
      }
      let expanded = memo.get(key);
      if (!expanded) {
        expandedXmlBytes += node.xml.length * 2;
        if (expandedXmlBytes > 3 * 1024 * 1024) {
          cost.bytes = Infinity;
          break;
        }
        const own = wordXmlCost(node.xml, undefined);
        expanded = scan(node.xml, node.path, new Set([...chain, key]));
        expanded.bytes += own.bytes;
        expanded.markup += own.markup;
        memo.set(key, expanded);
      }
      cost.bytes += expanded.bytes * copies;
      cost.markup += expanded.markup * copies;
      cost.media += expanded.media * copies;
      for (const image of expanded.images) cost.images.add(image);
    }
    return cost;
  };
  const costs = new Map<string, Cost>();
  let bytes = 0;
  let markup = 0;
  let media = 0;
  // Styles may introduce a page break before each styled paragraph. The page
  // bound also includes explicit breaks and section transitions in each batch.
  let stylePageBreaks = false;
  for (const [path, roles] of parts.roles)
    if (
      roles.has("styles") &&
      /<(?:\w+:)?pageBreakBefore\b/.test((await archive.file(path)?.async("string")) ?? "")
    )
      stylePageBreaks = true;
  for (const document of documents) {
    const pages = Math.max(
      1,
      document.match(
        stylePageBreaks ? /<(?:\w+:)?p\b/g : /<(?:\w+:)?(?:br|pageBreakBefore|sectPr)\b/g,
      )?.length ?? 0,
    );
    const expanded = scan(document, "word/document.xml", new Set(), pages);
    const body = wordXmlCost(document, undefined);
    bytes += body.bytes + expanded.bytes;
    markup += body.markup + expanded.markup;
    media += expanded.media;
    costs.set(document, expanded);
  }
  for (const [path, cost] of auxiliaryCosts) {
    if (optional.has(path) && !used.has(path)) continue;
    bytes += cost.bytes;
    markup += cost.markup;
  }
  const overBudget =
    bytes > 3 * 1024 * 1024 || markup > 100_000 || media > OFFICE_PREVIEW_MAX_BYTES;
  const truncated = (used.size > 0 && overBudget) || bytes === Infinity;
  const omitted = new Set([...optional].filter((path) => truncated || !used.has(path)));
  for (const path of omitted) archive.remove(path);
  if (truncated)
    for (const document of documents)
      costs.set(document, scan(document, "word/document.xml", new Set(), 1, false));
  // Remove relationships too: related XML is parsed even when not rendered.
  for (const [owner, refs] of parts.relationships) {
    const ids = new Set([...refs].filter(([, path]) => omitted.has(path)).map(([id]) => id));
    if (ids.size === 0) continue;
    const relPath = owner ? owner.replace(/([^/]+)$/, "_rels/$1.rels") : "_rels/.rels";
    let xml = await archive.file(relPath)?.async("string");
    if (!xml) continue;
    const removed: { start: number; end: number }[] = [];
    const parser = xmlParser();
    let start = -1;
    parser.on("opentag", (tag) => {
      if (tag.local === "Relationship" && ids.has(tag.attributes.Id?.value ?? ""))
        start = xml!.lastIndexOf("<", parser.position - 1);
    });
    parser.on("closetag", (tag) => {
      if (tag.local === "Relationship" && start >= 0) {
        removed.push({ start, end: parser.position });
        start = -1;
      }
    });
    parser.write(xml).close();
    for (const range of removed.toReversed())
      xml = xml.slice(0, range.start) + xml.slice(range.end);
    archive.file(relPath, xml);
  }
  return { costs, truncated, omitted };
}

// Stream each entry before handing it to an engine. A tiny compressed archive
// must not turn into an unbounded allocation on the UI thread.
export async function boundedArchive(input: Extract<OfficeWorkerRequest, { type: "open" }>) {
  const { bytes } = input;
  const spreadsheet = input.kind === "xlsx";
  if (bytes.byteLength > OFFICE_PREVIEW_MAX_BYTES)
    throw new Error("Preview limited to files under 50 MB.");
  checkZipDirectory(bytes);
  const source = await JSZip.loadAsync(bytes).catch(() => {
    throw new Error("This file is damaged, encrypted, or not a valid Office document.");
  });
  const allEntries = Object.values(source.files);
  if (allEntries.length > 2048)
    throw new Error("This file contains too many archive entries to preview.");
  const entries = allEntries.filter((entry) => !entry.dir);
  if (
    input.kind === "docx" &&
    entries.some((entry) => entry.name.includes("\\") || entry.name.startsWith("/"))
  )
    throw new Error("Preview limited: this Word document has unsupported archive paths.");
  const archive = new JSZip();
  const partTypes = wordPartTypes();
  // Metadata must be bounded and classified before any payload gets a media exemption.
  if (input.kind === "docx")
    entries.sort(
      (a, b) =>
        Number(b.name === "[Content_Types].xml" || b.name.endsWith(".rels")) -
        Number(a.name === "[Content_Types].xml" || a.name.endsWith(".rels")),
    );
  const costs = new Map<string, { bytes: number; markup: number }>();
  const mediaSizes = new Map<string, number>();
  let total = 0;
  let wordAuxiliaryMarkup = 0;
  let wordInputTruncated = false;
  let word: ReturnType<typeof wordDocuments> | null = null;
  for (const entry of entries) {
    const document = input.kind === "docx" && entry.name === "word/document.xml";
    const media = input.kind === "docx" && partTypes.binary(entry.name);
    const chunks: Uint8Array[] = [];
    const sections = document ? wordSections() : null;
    let decoder: TextDecoder | undefined;
    let length = 0;
    await new Promise<void>((resolve, reject) => {
      // JSZip exposes this streaming API at runtime but omits it from its types.
      const stream = (
        entry as JSZip.JSZipObject & {
          internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
        }
      ).internalStream("uint8array");
      stream
        .on("data", (chunk: Uint8Array) => {
          total += chunk.length;
          length += chunk.length;
          if (total > (spreadsheet ? 128 * 1024 * 1024 : OFFICE_PREVIEW_MAX_BYTES)) {
            stream.pause();
            reject(new Error("The expanded document is too large to preview safely."));
            return;
          }
          try {
            if (sections) {
              decoder ??= officeXmlDecoder(chunk);
              sections.write(decoder.decode(chunk, { stream: true }));
            }
          } catch (cause) {
            stream.pause();
            reject(cause);
            return;
          }
          if (document && length > 4 * 1024 * 1024) {
            const kept = Math.max(0, chunk.length - (length - 4 * 1024 * 1024));
            if (kept) chunks.push(chunk.subarray(0, kept));
            wordInputTruncated = true;
            return;
          }
          // Media is bounded independently. Even renamed auxiliary XML must
          // stay small before the engine parses it.
          if (input.kind === "docx" && !document && !media) {
            for (const byte of chunk) if (byte === 0x3c) wordAuxiliaryMarkup++;
            if (length > 1024 * 1024 || wordAuxiliaryMarkup > 50_000) {
              stream.pause();
              reject(
                new Error("Preview limited: this Word document has too much auxiliary markup."),
              );
              return;
            }
          }
          if (
            total > (spreadsheet ? 128 * 1024 * 1024 : OFFICE_PREVIEW_MAX_BYTES) ||
            (spreadsheet && total > Math.max(bytes.byteLength * 200, 8 * 1024 * 1024)) ||
            (!document &&
              (spreadsheet || media || entry.name.endsWith(".xml")) &&
              length > (spreadsheet ? 64 * 1024 * 1024 : 8 * 1024 * 1024))
          ) {
            stream.pause();
            reject(new Error("The expanded document is too large to preview safely."));
          } else chunks.push(chunk);
        })
        .on("error", reject)
        .on("end", resolve)
        .resume();
    });
    const content = new Uint8Array(document ? Math.min(length, 4 * 1024 * 1024) : length);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.length;
    }
    if (document) {
      sections!.write(decoder?.decode() ?? "");
      word = wordDocuments(officeXml(content), wordInputTruncated, sections!.finish());
      archive.file(entry.name, word.documents[0]!);
    } else if (input.kind === "docx" && !media) {
      let xml = officeXml(content);
      if (entry.name === "[Content_Types].xml" || entry.name.endsWith(".rels"))
        xml = partTypes.metadata(entry.name, xml);
      const roles = partTypes.roles.get(entry.name);
      const cost = wordXmlCost(xml, roles);
      // The renderer parses related parts even when their render option is off.
      if (roles && [...roles].every((role) => WORD_DISABLED_PARTS.has(role))) continue;
      if (
        (roles?.has("numbering") && cost.pictures) ||
        (roles?.has("styles") &&
          (cost.bytes > WORD_STYLE_MAX_BYTES || cost.markup > WORD_STYLE_MAX_UNITS)) ||
        (roles?.has("numbering") && (cost.bytes > 128 * 1024 || cost.markup > 2_000))
      ) {
        wordInputTruncated = true;
        continue;
      }
      costs.set(entry.name, cost);
      archive.file(entry.name, xml);
    } else {
      if (input.kind === "docx" && partTypes.roles.get(entry.name)?.has("font")) {
        continue;
      }
      if (media) mediaSizes.set(entry.name, Math.ceil((content.length * 4) / 3));
      archive.file(entry.name, /\.(?:xml|rels)$/i.test(entry.name) ? officeXml(content) : content);
    }
  }
  if (word) {
    const expansion = await wordExpansion(archive, partTypes, mediaSizes, costs, word.documents);
    wordInputTruncated ||= expansion.truncated;
    for (const path of expansion.omitted) {
      archive.remove(path);
      costs.delete(path);
    }
    let mediaBytes = 0;
    const usedImages = new Set<string>();
    const auxiliary = [...costs.values()].reduce(
      (sum, cost) => ({ bytes: sum.bytes + cost.bytes, markup: sum.markup + cost.markup }),
      { bytes: 0, markup: 0 },
    );
    // The worker engine parses shared parts once, rather than once per legacy render batch.
    let bytes = auxiliary.bytes;
    let markup = auxiliary.markup;
    const documents: string[] = [];
    for (const document of word.documents) {
      const rawCost = wordXmlCost(document, undefined);
      const extra = expansion.costs.get(document)!;
      const cost = { bytes: rawCost.bytes + extra.bytes, markup: rawCost.markup + extra.markup };
      const images = extra.media;
      const batchImages = new Set(extra.images);
      if (
        bytes + cost.bytes > 3 * 1024 * 1024 ||
        markup + cost.markup > 100_000 ||
        mediaBytes + images > OFFICE_PREVIEW_MAX_BYTES
      )
        break;
      bytes += cost.bytes;
      markup += cost.markup;
      mediaBytes += images;
      for (const path of batchImages) usedImages.add(path);
      documents.push(document);
    }
    if (documents.length === 0)
      throw new Error("Preview limited: this Word document has too much expanded markup.");
    word.truncated ||= wordInputTruncated || documents.length < word.documents.length;
    word.documents = documents;
    for (const path of mediaSizes.keys()) if (!usedImages.has(path)) archive.remove(path);
    archive.file("word/document.xml", documents[0]!);
  }
  const truncatedSheets = input.kind === "xlsx" ? await boundWorkbook(archive) : [];
  return { archive, word, truncatedSheets };
}

export async function prepareOffice(
  bytes: ArrayBuffer,
  kind: Extract<OfficeWorkerRequest, { type: "open" }>["kind"],
) {
  const result = await boundedArchive({ type: "open", kind, bytes });
  const root =
    kind === "docx"
      ? "word/document.xml"
      : kind === "xlsx"
        ? "xl/workbook.xml"
        : "ppt/presentation.xml";
  if (!result.archive.file(root))
    throw new Error("This is not a valid Office Open XML file. Encrypted files are not supported.");
  if (result.word) {
    const references = new Map<string, string>();
    const relationships = xmlParser();
    relationships.on("opentag", (tag) => {
      if (tag.local !== "Relationship") return;
      const type = tag.attributes.Type?.value ?? "";
      const target = tag.attributes.Target?.value ?? "";
      const path = new URL(target, "https://docx.invalid/word/").pathname.slice(1);
      if (result.archive.file(path))
        references.set(tag.attributes.Id?.value ?? "", type.slice(type.lastIndexOf("/") + 1));
    });
    const relationshipXml = await result.archive
      .file("word/_rels/document.xml.rels")
      ?.async("string");
    if (relationshipXml) relationships.write(relationshipXml).close();
    let xml = joinWordBatches(result.word.documents);
    const removed: { start: number; end: number }[] = [];
    const parser = xmlParser();
    let start = -1;
    // Bounded parts can be omitted; dangling story references otherwise reject the entire body in the engine.
    parser.on("opentag", (tag) => {
      if (tag.local !== "headerReference" && tag.local !== "footerReference") return;
      const id = Object.values(tag.attributes).find((attr) => attr.local === "id")?.value ?? "";
      if (references.get(id) !== tag.local.replace("Reference", ""))
        start = xml.lastIndexOf("<", parser.position - 1);
    });
    parser.on("closetag", (tag) => {
      if (start >= 0 && (tag.local === "headerReference" || tag.local === "footerReference")) {
        removed.push({ start, end: parser.position });
        start = -1;
      }
    });
    parser.write(xml).close();
    for (const range of removed.toReversed())
      xml = xml.slice(0, range.start) + xml.slice(range.end);
    result.archive.file(root, xml);
  }
  return {
    bytes: await result.archive.generateAsync({ type: "arraybuffer", compression: "STORE" }),
    truncated: result.word?.truncated || result.truncatedSheets.some(Boolean) || false,
  };
}

export function joinWordBatches(documents: string[]) {
  let prefix = "";
  let suffix = "";
  let section = "";
  const bodies: string[] = [];
  for (const xml of documents) {
    const parser = xmlParser();
    let depth = 0;
    let start = 0;
    let end = 0;
    let sectionStart = 0;
    parser.on("opentag", (tag) => {
      depth++;
      if (depth === 2 && tag.local === "body") {
        start = parser.position;
        if (!prefix) prefix = xml.slice(0, start);
      }
      if (depth === 3 && tag.local === "sectPr")
        sectionStart = xml.lastIndexOf("<", parser.position - 1);
    });
    parser.on("closetag", (tag) => {
      if (depth === 2 && tag.local === "body") {
        end = xml.lastIndexOf("<", parser.position - 1);
        suffix = xml.slice(end);
      }
      depth--;
    });
    parser.write(xml).close();
    bodies.push(xml.slice(start, sectionStart || end));
    section = sectionStart ? xml.slice(sectionStart, end) : "";
  }
  return prefix + bodies.join("") + section + suffix;
}

