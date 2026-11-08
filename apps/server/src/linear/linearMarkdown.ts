/** Linear signs private download URLs on reads. Persist the stable asset URL on edits. */
export function stableLinearMarkdown(text: string): string {
  return text.replace(/https:\/\/uploads\.linear\.app\/[^\s<>"\])]+/g, (value) => {
    const url = new URL(value);
    if (url.searchParams.has("signature")) {
      url.search = "";
      return url.href;
    }
    return value;
  });
}
