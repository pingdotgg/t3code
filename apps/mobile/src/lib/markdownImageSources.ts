import { parseMarkdownDocument, type MarkdownNode } from "./markdownDocument";

export interface MarkdownImageRef {
  readonly url: string;
  readonly alt: string | null;
}

export function markdownImages(markdown: string): MarkdownImageRef[] {
  if (!markdown.includes("![") && !/<img[\s>]/i.test(markdown)) return [];
  const document = parseMarkdownDocument(markdown);
  const definitions = new Map<string, { readonly url: string; readonly title: string | null }>();
  const collectDefinitions = (node: MarkdownNode) => {
    if (node.type === "definition") {
      const id = node.identifier.toLowerCase();
      if (!definitions.has(id)) {
        definitions.set(id, { url: node.url, title: node.title ?? null });
      }
      return;
    }
    if ("children" in node) node.children.forEach(collectDefinitions);
  };
  collectDefinitions(document);
  const images = new Map<string, string | null>();
  const record = (
    url: string,
    alt: string | null | undefined,
    title: string | null | undefined,
  ) => {
    const label = alt?.trim() || title?.trim() || null;
    const existing = images.get(url);
    if (existing === undefined || (existing === null && label !== null)) {
      images.set(url, label);
    }
  };
  const visit = (node: MarkdownNode) => {
    if (node.type === "image") {
      record(node.url, node.alt, node.title);
    } else if (node.type === "imageReference") {
      const def = definitions.get(node.identifier.toLowerCase());
      if (def) record(def.url, node.alt, def.title);
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(document);
  return [...images.entries()].map(([url, alt]) => ({ url, alt }));
}

export function markdownImageSources(markdown: string): string[] {
  return markdownImages(markdown).map((image) => image.url);
}
