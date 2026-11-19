// Linear signs uploads with a lone `?signature=<JWT>`; match only that token so
// Markdown or punctuation right after the URL survives.
const SIGNED_UPLOAD =
  /(https:\/\/uploads\.linear\.app\/[^\s?#<>"'`()[\]*]+)\?signature=[\w-]+(?:\.[\w-]+)*(?![\w&=-]|\.[\w-])/gu;

export function stripLinearFileSignatures(markdown: string): string {
  return markdown.replace(SIGNED_UPLOAD, "$1");
}
