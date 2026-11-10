import * as Schema from "effect/Schema";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  inlineCodeFilePathCandidate,
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
  const sources = [
    ...extractMarkdownLinkHrefs(finalText),
    ...extractInlineCodeSpans(finalText).flatMap((span) => inlineCodeFilePathCandidate(span) ?? []),
  ];
  return [...new Set(sources)].flatMap((source) => {
    const target = resolveMarkdownFileLinkTarget(source, cwd);
    if (target === null) return [];
    const path = splitFilePathPosition(target).path.replace(/\/+$/, "");
    // System paths such as /usr/bin/node are not what these cases test.
    if (!/^\/(?:home|Users)\//.test(path)) return [];
    const relative = splitFilePathPosition(source).path;
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
          ? entries.filter((entry) => entry.path.split("/").at(-1) === relative).length === 1
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
