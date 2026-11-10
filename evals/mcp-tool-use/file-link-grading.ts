import * as Schema from "effect/Schema";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  inlineCodeFilePathCandidate,
  isMarkdownFileLinkLabel,
  normalizeMarkdownLinkDestination,
  parseMarkdownFileLink,
  resolveMarkdownFileLinkTarget,
} from "@t3tools/shared/markdownLinks";
import {
  needsWorkspaceBasenameLookup,
  pickWorkspaceLinkMatch,
} from "../../packages/client-runtime/src/workspaceBasenameLookup.ts";

export const FileLinksExpect = Schema.Struct({
  /** The final answer has at least this many file pills that open a world file. */
  minWorking: Schema.Number,
});

/** Resolves `.` and `..` segments, which the file system resolves when the client opens the path. */
const normalizeAbsolutePath = (path: string) => {
  const segments: Array<string> = [];
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  return `/${segments.join("/")}`;
};

/** The client opens an exact basename match, or a case-insensitive one when only one exists. */
const uniqueBasename = (name: string, entries: ReadonlyArray<{ readonly path: string }>) => {
  const basenames = entries.map((entry) => entry.path.split("/").at(-1) ?? "");
  const exact = basenames.filter((basename) => basename === name).length;
  return (
    exact === 1 ||
    (exact === 0 &&
      basenames.filter((basename) => basename.toLowerCase() === name.toLowerCase()).length === 1)
  );
};

/**
 * Chat turns every file-shaped markdown link and inline code span into a pill resolved against
 * the thread's cwd. A pill is broken when it lands on no world file or directory and the client's
 * on-click lookup (basename, repeated prefix, unique suffix) finds no one file under the cwd.
 */
export const fileLinkPills = (
  finalText: string,
  cwd: string,
  worldFiles: ReadonlyArray<string>,
) => {
  const files = worldFiles.map((file) => (file.startsWith("/") ? file : `${cwd}/${file}`));
  // A link whose label names its own file renders as one pill, so code in that label is no pill.
  // Fenced blocks render as code, never as pills.
  const prose = finalText.replace(/```[\s\S]*?(?:```|$)/g, "");
  const withoutFileLabels = prose.replace(
    /\[([^\]\n]*)\]\(([^)\s]+)\)/g,
    (link, label: string, href: string) =>
      isMarkdownFileLinkLabel(label.replaceAll("`", ""), normalizeMarkdownLinkDestination(href))
        ? `[](${href})`
        : link,
  );
  const sources = [
    ...extractMarkdownLinkHrefs(prose),
    ...extractInlineCodeSpans(withoutFileLabels).flatMap(
      (span) => inlineCodeFilePathCandidate(span) ?? [],
    ),
  ];
  return [...new Set(sources)].flatMap((source) => {
    const target = resolveMarkdownFileLinkTarget(source, cwd);
    if (target === null) return [];
    const path = normalizeAbsolutePath(splitFilePathPosition(target).path);
    // System paths such as /usr/bin/node are not what these cases test.
    if (!/^\/(?:home|Users)\//.test(path)) return [];
    const relative = parseMarkdownFileLink(source)?.path ?? path;
    const entries = files.flatMap((file) =>
      file.startsWith(`${cwd}/`)
        ? [{ path: file.slice(cwd.length + 1), kind: "file" as const }]
        : [],
    );
    const works =
      files.some((file) => file === path || file.startsWith(`${path}/`)) ||
      (!relative.startsWith("/") &&
        // The client opens the first of several same-named files, which may be the wrong one.
        (needsWorkspaceBasenameLookup(relative)
          ? uniqueBasename(relative, entries)
          : pickWorkspaceLinkMatch(relative, cwd, entries) !== null));
    return [{ source, path, works }];
  });
};

export const gradeFileLinks = (
  expect: typeof FileLinksExpect.Type | undefined,
  finalText: string | undefined,
  cwd: string | undefined,
  worldFiles: ReadonlyArray<string>,
) => {
  if (expect === undefined) return [];
  const pills = cwd === undefined ? [] : fileLinkPills(finalText ?? "", cwd, worldFiles);
  const broken = pills.filter((pill) => !pill.works).map((pill) => pill.source);
  const working = pills.length - broken.length;
  return [
    {
      check: `fileLinks none broken${broken.length ? `: ${broken.join(", ")}` : ""}`,
      pass: finalText !== undefined && cwd !== undefined && broken.length === 0,
    },
    {
      check: `fileLinks >= ${expect.minWorking} working (${working})`,
      pass: working >= expect.minWorking,
    },
  ];
};
