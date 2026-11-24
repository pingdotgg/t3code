import { parseMarkdownDocument, type MarkdownNode } from "./markdownDocument";

export interface MarkdownImageNode {
  readonly url: string;
  readonly alt: string | null;
  readonly title: string | null;
}

/** Inline and reference-style images in document order; references resolve against `definitionsRoot`. */
export function markdownDocumentImages(
  document: MarkdownNode,
  definitionsRoot: MarkdownNode = document,
): MarkdownImageNode[] {
  const definitions = new Map<string, { readonly url: string; readonly title: string | null }>();
  const collectDefinitions = (node: MarkdownNode) => {
    if (node.type === "definition") {
      const id = node.identifier.toLowerCase();
      if (!definitions.has(id)) definitions.set(id, { url: node.url, title: node.title ?? null });
      return;
    }
    if ("children" in node) node.children.forEach(collectDefinitions);
  };
  collectDefinitions(definitionsRoot);
  const images: MarkdownImageNode[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "image") {
      images.push({ url: node.url, alt: node.alt ?? null, title: node.title ?? null });
    } else if (node.type === "imageReference") {
      const definition = definitions.get(node.identifier.toLowerCase());
      if (definition) images.push({ ...definition, alt: node.alt ?? null });
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(document);
  return images;
}

/** Unique image URLs, each with the first non-empty alt or title it was given. */
export function markdownImages(
  markdown: string,
): { readonly url: string; readonly alt: string | null }[] {
  if (!markdown.includes("![") && !/<img[\s>]/i.test(markdown)) return [];
  const images = new Map<string, string | null>();
  for (const image of markdownDocumentImages(parseMarkdownDocument(markdown))) {
    const label = image.alt?.trim() || image.title?.trim() || null;
    if ((images.get(image.url) ?? null) === null) images.set(image.url, label);
  }
  return [...images.entries()].map(([url, alt]) => ({ url, alt }));
}

export function markdownImageSources(markdown: string): string[] {
  return markdownImages(markdown).map((image) => image.url);
}
