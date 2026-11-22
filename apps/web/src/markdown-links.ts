import { isLocalEditorFileUrl } from "@t3tools/contracts";
import { fileBasename, isAbsolutePath, workspaceRelativeFilePath } from "@t3tools/shared/path";
import {
  inlineCodeFilePathCandidate,
  isRelativeFilePath,
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLink,
} from "@t3tools/shared/markdownLinks";
import { parseFileUrlHref, splitFilePathPosition } from "@t3tools/shared/fileLinks";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { isTerminalLinkActivation } from "./terminal-links";

export interface MarkdownFileLinkMeta {
  filePath: string;
  workspaceLookupPath: string | null;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
  endLine?: number;
}

export function shouldOpenMarkdownFileLinkInEditor(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform?: string,
): boolean {
  return isTerminalLinkActivation(event, platform);
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(normalizeMarkdownLinkDestination(href));
  return target ? `${target.path}${target.hash}` : null;
}

export function isLocalEditorFileHref(href: string): boolean {
  try {
    return isLocalEditorFileUrl(new URL(href));
  } catch {
    return false;
  }
}

// Every message resolves its links and code spans more than once while rendering.
const MAX_MEMOIZED = 4_000;
const inlineCodeMetas = new Map<string, MarkdownFileLinkMeta | null>();
const linkMetas = new Map<string, MarkdownFileLinkMeta | null>();

function memoized(
  cache: Map<string, MarkdownFileLinkMeta | null>,
  key: string,
  resolve: () => MarkdownFileLinkMeta | null,
): MarkdownFileLinkMeta | null {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (cache.size >= MAX_MEMOIZED) cache.clear();
  const meta = resolve();
  cache.set(key, meta);
  return meta;
}

export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  return memoized(inlineCodeMetas, `${cwd ?? ""}\u0000${baseDir ?? ""}\u0000${codeText}`, () =>
    resolveInlineCodeFileLinkMetaUncached(codeText, cwd, baseDir),
  );
}

function resolveInlineCodeFileLinkMetaUncached(
  codeText: string,
  cwd: string | undefined,
  baseDir: string | undefined,
): MarkdownFileLinkMeta | null {
  const candidate = inlineCodeFilePathCandidate(codeText);
  if (candidate === null) return null;

  return resolveMarkdownFileLinkMeta(
    candidate,
    cwd,
    inlineCodePathNamesFromWorkspaceRoot(candidate, cwd, baseDir) ? cwd : baseDir,
  );
}

function inlineCodePathNamesFromWorkspaceRoot(
  candidate: string,
  cwd: string | undefined,
  baseDir: string | undefined,
): boolean {
  if (!cwd || !baseDir || !isRelativeFilePath(candidate)) return false;
  if (/^(?:~|\.{1,2})\//.test(candidate)) return false;
  if (!splitFilePathPosition(candidate).path.includes("/")) return false;
  return workspaceRelativeFilePath(baseDir, cwd) !== null;
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  if (href === undefined) return null;
  return memoized(linkMetas, `${cwd ?? ""}\u0000${baseDir ?? ""}\u0000${href}`, () =>
    resolveMarkdownFileLinkMetaUncached(href, cwd, baseDir),
  );
}

function resolveMarkdownFileLinkMetaUncached(
  href: string | undefined,
  cwd: string | undefined,
  baseDir: string | undefined,
): MarkdownFileLinkMeta | null {
  const resolved = resolveMarkdownFileLink(href, cwd, baseDir);
  if (!resolved) return null;
  const {
    sourcePath,
    targetPath,
    position: { path, ...lines },
  } = resolved;
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...lines,
    workspaceLookupPath:
      !isAbsolutePath(sourcePath) &&
      baseDir !== undefined &&
      workspaceRelativeFilePath(baseDir, cwd) === "."
        ? sourcePath
        : null,
  };
}
