import {
  getBrowseDirectoryPath,
  isExplicitRelativeProjectPath,
  isFilesystemBrowseQuery,
} from "./projectPaths";

export function canBrowseComposerFilesystemPath(
  query: string,
  cwd: string | null,
  platform: string,
): boolean {
  return (
    isFilesystemBrowseQuery(query, platform) &&
    (!isExplicitRelativeProjectPath(query) || cwd !== null)
  );
}

export function isComposerFilesystemPathQuery(query: string, platform: string): boolean {
  return isFilesystemBrowseQuery(query, platform);
}

export function composerFilesystemSuggestionParentPath(query: string): string {
  return getBrowseDirectoryPath(query);
}

export function composerFilesystemSuggestionPath(query: string, entryName: string): string {
  return `${getBrowseDirectoryPath(query)}${entryName}`;
}
