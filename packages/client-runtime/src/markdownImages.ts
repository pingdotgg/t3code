import {
  normalizeMarkdownLinkDestination,
  splitMarkdownLinkSearchAndHash,
} from "@t3tools/shared/markdownLinks";

export {
  classifyMarkdownImageSource,
  type MarkdownImageSource,
} from "@t3tools/shared/markdownLinks";

export function markdownImageSourceFragment(source: string): string {
  return splitMarkdownLinkSearchAndHash(normalizeMarkdownLinkDestination(source)).hash;
}
