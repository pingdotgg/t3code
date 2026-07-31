export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

export const isHtmlPreviewFile = (path: string): boolean => /\.html?$/i.test(path);

const HTML_HEAD_OPEN_PATTERN = /<head\b[^>]*>/i;
const HTML_HEAD_CLOSE_PATTERN = /<\/head\s*>/i;
const HTML_OPEN_PATTERN = /<html\b[^>]*>/i;
const HTML_DOCTYPE_PATTERN = /^\s*<!doctype\b[^>]*>/i;
const HTML_BASE_HREF_PATTERN =
  /(<base\b[^>]*?\bhref\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

const escapeHtmlAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

export function prepareHtmlPreviewDocument(contents: string, assetUrl: string): string {
  const assetDirectoryUrl = new URL(".", assetUrl).toString();
  const escapedAssetDirectoryUrl = escapeHtmlAttribute(assetDirectoryUrl);
  const baseTag = `<base href="${escapedAssetDirectoryUrl}">`;
  const headOpenMatch = HTML_HEAD_OPEN_PATTERN.exec(contents);

  if (headOpenMatch?.index !== undefined) {
    const headContentsStart = headOpenMatch.index + headOpenMatch[0].length;
    const headCloseMatch = HTML_HEAD_CLOSE_PATTERN.exec(contents.slice(headContentsStart));
    const headContentsEnd = headCloseMatch
      ? headContentsStart + headCloseMatch.index
      : contents.length;
    const headContents = contents.slice(headContentsStart, headContentsEnd);
    const existingBaseMatch = HTML_BASE_HREF_PATTERN.exec(headContents);

    if (existingBaseMatch?.index !== undefined) {
      const existingHref =
        existingBaseMatch[2] ?? existingBaseMatch[3] ?? existingBaseMatch[4] ?? "";
      let resolvedHref = assetDirectoryUrl;
      try {
        resolvedHref = new URL(existingHref, assetUrl).toString();
      } catch {
        // An invalid authored base behaves like no usable base for the preview.
      }
      const matchStart = headContentsStart + existingBaseMatch.index;
      const matchEnd = matchStart + existingBaseMatch[0].length;
      return `${contents.slice(0, matchStart)}${existingBaseMatch[1]}"${escapeHtmlAttribute(resolvedHref)}"${contents.slice(matchEnd)}`;
    }

    return `${contents.slice(0, headContentsStart)}${baseTag}${contents.slice(headContentsStart)}`;
  }

  const htmlOpenMatch = HTML_OPEN_PATTERN.exec(contents);
  if (htmlOpenMatch?.index !== undefined) {
    const insertAt = htmlOpenMatch.index + htmlOpenMatch[0].length;
    return `${contents.slice(0, insertAt)}<head>${baseTag}</head>${contents.slice(insertAt)}`;
  }

  const doctypeMatch = HTML_DOCTYPE_PATTERN.exec(contents);
  const insertAt = doctypeMatch?.[0].length ?? 0;
  return `${contents.slice(0, insertAt)}<head>${baseTag}</head>${contents.slice(insertAt)}`;
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
