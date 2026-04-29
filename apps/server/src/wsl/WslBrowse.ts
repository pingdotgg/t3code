import type { FilesystemBrowseResult } from "@t3tools/contracts";

export const WSL_BROWSE_SCRIPT = [
  "set -eu",
  "partial=${1-}",
  'case "$partial" in',
  '  "~") partial=$HOME ;;',
  '  "~/"*) partial=$HOME/${partial#~/} ;;',
  "esac",
  'case "$partial" in',
  '  /*) target=$(realpath -m -- "$partial") ;;',
  '  *) target=$(realpath -m -- "$PWD/$partial") ;;',
  "esac",
  'if [ -z "$partial" ]; then',
  "  parent=$target; prefix=",
  "else",
  '  case "$partial" in',
  "    */) parent=$target; prefix= ;;",
  '    *) parent=$(dirname -- "$target"); prefix=$(basename -- "$target") ;;',
  "  esac",
  "fi",
  '[ -d "$parent" ] || exit 3',
  'echo "$parent"',
  'echo "__PREFIX__:$prefix"',
  'for path in "$parent"/* "$parent"/.*; do',
  '  [ -d "$path" ] || continue',
  '  name=$(basename -- "$path")',
  '  [ "$name" = "." ] && continue',
  '  [ "$name" = ".." ] && continue',
  '  echo "__ENTRY__:$name:$path"',
  "done",
].join("; ");

export function parseWslBrowseOutput(stdout: string): FilesystemBrowseResult {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const parentPath = lines[0];
  const prefixLine = lines.find((line) => line.startsWith("__PREFIX__:"));
  const prefix = prefixLine ? prefixLine.slice("__PREFIX__:".length) : "";
  if (!parentPath) {
    throw new Error("WSL browse response did not include a parent path.");
  }

  const lowerPrefix = prefix.toLowerCase();
  const showHidden = prefix.length === 0 || prefix.startsWith(".");
  const entries: Array<FilesystemBrowseResult["entries"][number]> = [];

  for (const line of lines) {
    if (!line.startsWith("__ENTRY__:")) continue;
    const entry = line.slice("__ENTRY__:".length);
    const separator = entry.lastIndexOf(":");
    if (separator <= 0) continue;
    const name = entry.slice(0, separator);
    const fullPath = entry.slice(separator + 1);
    if (!fullPath) continue;
    if (!name.toLowerCase().startsWith(lowerPrefix)) continue;
    if (!showHidden && name.startsWith(".")) continue;
    entries.push({ name, fullPath });
  }

  return {
    parentPath,
    entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}
