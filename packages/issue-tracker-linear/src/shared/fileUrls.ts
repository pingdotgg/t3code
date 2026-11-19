export function stripLinearFileSignatures(markdown: string): string {
  return markdown.replace(/https:\/\/uploads\.linear\.app\/[^\s<>"\])]+/gu, (asset) => {
    const url = new URL(asset);
    if (!url.searchParams.has("signature")) return asset;
    url.searchParams.delete("signature");
    return url.href;
  });
}
