/**
 * Package-owned navigation helpers — the panel-local half of the
 * native FilePreviewPanel's path machinery: breadcrumbs over the tree
 * snapshot, workspace link/path resolution, centered line-reveal geometry,
 * and the composer-mention drag payload. Everything here is a pure function
 * over data the package already holds; no host contract is involved.
 */
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

/* ---------------- path classification (native: terminal-links.ts) -------- */

/** Absolute host path: posix root, windows drive, or UNC share. */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

/* ---------------- `path:line[:column]` / `#L…` positions ------------------ */

export interface FilePathPosition {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

const POSITION_SUFFIX_CAPTURE_PATTERN = /:(\d+)(?::(\d+))?$/;
const POSITION_HASH_PATTERN = /^#L(\d+)(?:C(\d+))?$/i;

/**
 * Split a written `path:line[:column]` suffix or a `#L…`/`#L…C…` hash off a
 * link target. Mirrors the client-runtime markdown-links helper; a `:0`
 * suffix or `#L0` anchor is not a position.
 */
export function splitFilePathPosition(path: string, hash = ""): FilePathPosition {
  const suffixMatch = path.match(POSITION_SUFFIX_CAPTURE_PATTERN);
  const match = suffixMatch ?? hash.match(POSITION_HASH_PATTERN);
  if (!match?.[1]) return { path };
  const line = Number.parseInt(match[1], 10);
  const column = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
  return {
    path: suffixMatch ? path.slice(0, -suffixMatch[0].length) : path,
    ...(line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {}),
  };
}

/* ---------------- workspace link resolution ----------------------------- */

/**
 * What a markdown/link href resolves to for this panel. The plugin never
 * learns the workspace root, so host-absolute and home-relative targets are
 * `external` — they cannot become a workspace-relative open and stay
 * non-navigable. `anchor` is a same-document `#…` href; only `#L…` carries
 * a reveal line.
 */
export type WorkspaceLinkTarget =
  | { readonly kind: "workspace"; readonly path: string; readonly line?: number }
  | { readonly kind: "external"; readonly path: string }
  | { readonly kind: "anchor"; readonly line?: number }
  | { readonly kind: "not-a-path" };

const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
// Written as a regex so the source never contains the bare tilde-slash token
// the extension import audit reserves for the apps/web path alias.
const HOME_RELATIVE_PATTERN = /^~\//;

function normalizeWorkspaceSegments(segments: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // `..` past the workspace root is an outside-workspace path.
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    if (segment.includes("\\")) return null;
    out.push(segment);
  }
  return out;
}

/**
 * Resolve a link href to a workspace-relative open target. `baseDir` is the
 * directory of the document the link was written in ("" at the root). The
 * `scheme:` check keeps `path:12` position suffixes working — a scheme whose
 * remainder is only digits is a line reference, not a scheme.
 */
export function resolveWorkspaceLink(href: string, baseDir: string): WorkspaceLinkTarget {
  const trimmed = href.trim();
  if (trimmed.length === 0) return { kind: "not-a-path" };

  const hashIndex = trimmed.indexOf("#");
  const rawPath = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : trimmed.slice(hashIndex);

  if (rawPath.length === 0) {
    const position = splitFilePathPosition("", hash);
    return { kind: "anchor", ...(position.line !== undefined ? { line: position.line } : {}) };
  }

  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { kind: "not-a-path" };
  }

  const position = splitFilePathPosition(decoded, hash);
  const path = position.path;
  if (path.length === 0) return { kind: "not-a-path" };

  if (HOME_RELATIVE_PATTERN.test(path) || isAbsolutePath(path)) {
    return { kind: "external", path };
  }

  const scheme = path.match(EXTERNAL_SCHEME_PATTERN);
  if (scheme !== null && !POSITION_ONLY_PATTERN.test(scheme[2] ?? "")) {
    return { kind: "not-a-path" };
  }

  const segments = normalizeWorkspaceSegments([
    ...(baseDir === "" ? [] : baseDir.split("/")),
    ...path.split("/"),
  ]);
  // `null` is an escape above the root and stays inert; the empty result is
  // the workspace root itself — a valid directory target the caller maps to
  // "reveal the tree's top level" (the snapshot has no entry for it).
  if (segments === null) return { kind: "not-a-path" };
  return {
    kind: "workspace",
    path: segments.join("/"),
    ...(position.line !== undefined ? { line: position.line } : {}),
  };
}

/* ---------------- breadcrumbs (native: filePath.ts) --------------------- */

export interface FileBreadcrumb {
  readonly label: string;
  readonly path: string;
  readonly kind: "project" | "directory" | "file";
}

export interface FileBreadcrumbChild {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly label: string;
}

/**
 * Crumbs for a workspace-relative path start at `rootLabel`. No public
 * contract reports the project title to a project-scope view, so the caller
 * supplies the label; an absolute host path is outside the workspace and its
 * crumbs start at the filesystem root instead.
 */
export function fileBreadcrumbs(rootLabel: string, relativePath: string): FileBreadcrumb[] {
  const hostPath = isAbsolutePath(relativePath);
  const separator = isWindowsAbsolutePath(relativePath) ? "\\" : "/";
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const root = relativePath.startsWith("\\\\") ? "\\\\" : hostPath && separator === "/" ? "/" : "";
  return [
    ...(hostPath ? [] : [{ label: rootLabel, path: "", kind: "project" as const }]),
    ...parts.map((part, index) => ({
      label: part,
      path: root + parts.slice(0, index + 1).join(separator),
      kind: index === parts.length - 1 ? ("file" as const) : ("directory" as const),
    })),
  ];
}

/** Direct children of a crumb's directory, directories first, name-sorted. */
export function fileBreadcrumbChildren(
  entries: readonly { readonly path: string; readonly kind: "file" | "directory" }[],
  directoryPath: string,
): FileBreadcrumbChild[] {
  let collator: Intl.Collator | undefined;
  const prefix = directoryPath ? `${directoryPath}/` : "";
  return entries
    .flatMap((entry) => {
      if (!entry.path.startsWith(prefix)) return [];
      const label = entry.path.slice(prefix.length);
      if (!label || label.includes("/")) return [];
      return [{ ...entry, label }];
    })
    .toSorted((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      collator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      return collator.compare(left.label, right.label);
    });
}

/** Parent of a workspace directory path; null at the root (""). */
export function fileBreadcrumbParent(directoryPath: string): string | null {
  if (!directoryPath) return null;
  const separatorIndex = directoryPath.lastIndexOf("/");
  return separatorIndex === -1 ? "" : directoryPath.slice(0, separatorIndex);
}

/* ---------------- line reveal (native: fileLineReveal.ts) --------------- */

interface LineGeometry {
  readonly top: number;
  readonly height: number;
}

export interface CenteredFileLineScrollInput {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly viewportTop: number;
  readonly viewportHeight: number;
  readonly fileTop: number;
  readonly estimatedLine: LineGeometry;
  readonly renderedLine?: LineGeometry;
}

/**
 * Scroll offset that centers a line in the viewport, clamped to the scroll
 * range — the same math the native reveal uses. `renderedLine` (measured
 * geometry) wins over the line-height estimate when the line is on screen.
 */
export function resolveCenteredFileLineScrollTop(input: CenteredFileLineScrollInput): number {
  const lineTop =
    input.renderedLine === undefined
      ? input.fileTop + input.estimatedLine.top
      : input.scrollTop + input.renderedLine.top - input.viewportTop;
  const lineHeight = input.renderedLine?.height ?? input.estimatedLine.height;
  const centeredTop = Math.max(0, lineTop - Math.max(0, (input.viewportHeight - lineHeight) / 2));
  return Math.min(centeredTop, Math.max(0, input.scrollHeight - input.viewportHeight));
}

/** Character offset where 1-based `line` starts, clamped into the text. */
export function lineStartOffset(text: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const newline = text.indexOf("\n", offset);
    if (newline === -1) return text.length;
    offset = newline + 1;
  }
  return offset;
}

/* ------------- composer mention drags (native: fileTreeDragMention.ts) --- */

/**
 * The drag MIME the host composer claims (`dataTransferHasComposerMention`).
 * Plugin views share the host document, so tagging a row's drag with this
 * type and the serialized mention is the whole contract — no API call.
 */
export const COMPOSER_MENTION_DRAG_TYPE = "application/x-t3code-composer-mention";

/**
 * The mention payload for a set of dragged paths, or null when none of them
 * serialize — mirrors `composerMentionFromTreePath` (trailing slashes
 * stripped) and the native join.
 */
export function dragMentionPayload(paths: readonly string[]): string | null {
  const mentions = paths.flatMap((path) => {
    const relativePath = path.replace(/\/+$/, "");
    return relativePath.length === 0 ? [] : [serializeComposerFileLink(relativePath)];
  });
  return mentions.length === 0 ? null : mentions.join(" ");
}
