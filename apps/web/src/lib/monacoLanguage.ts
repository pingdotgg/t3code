const languageByExtension = new Map<string, string>([
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["json", "json"],
  ["css", "css"],
  ["scss", "scss"],
  ["less", "less"],
  ["html", "html"],
  ["htm", "html"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["xml", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
]);

export function resolveMonacoLanguage(filePath: string): string | undefined {
  const normalizedPath = filePath.trim().replaceAll("\\", "/");
  const fileName = normalizedPath.split("/").at(-1)?.toLowerCase() ?? "";
  const extension = fileName.split(".").at(-1);
  if (!extension || extension === fileName) {
    return undefined;
  }
  return languageByExtension.get(extension);
}
