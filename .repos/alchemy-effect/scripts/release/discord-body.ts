/**
 * Transform a CHANGELOG.md entry body (written for GitHub Releases, which
 * render HTML) into text suitable for a Discord embed description.
 *
 * Discord renders neither HTML entities nor the `<samp>` tag, and only
 * honors `#`, `##`, and `###` headings. The CHANGELOG entries produced by
 * `render.ts` / `changelogithub` use:
 *
 *   - `&nbsp;` sequences to visually indent `###`/`#####` headings and
 *     author/PR separators (`&nbsp;-&nbsp;`)
 *   - `<samp>(hash)</samp>` to render commit-hash links in small caps
 *   - A trailing `#####` "View changes on GitHub" line
 *
 * This converts those into plain-text / markdown equivalents.
 */
export function toDiscordBody(rawBody: string): string {
  return (
    rawBody
      .replace(/&nbsp;/g, " ")
      .replace(/<\/?samp>/g, "`")
      // Collapse the long indent that the GitHub-flavored headings use.
      .replace(/^(#{1,6})\s+/gm, "$1 ")
      // Discord only renders #, ##, ### as headings; drop deeper levels so
      // lines like "##### View changes on GitHub" become plain text.
      .replace(/^#{4,6}\s+/gm, "")
      // Strip any other stray HTML tags just in case.
      .replace(/<\/?[a-z][^>]*>/gi, "")
  );
}

/**
 * Extract the body for a single `## <tag>` entry out of a CHANGELOG.md
 * string. Stops at the `---` separator that `release-notes.ts` inserts
 * between entries, or at the next `## ` heading if the separator is
 * missing. Returns `undefined` if the tag isn't present.
 */
export function extractTagBody(
  changelog: string,
  tag: string,
): string | undefined {
  const heading = `## ${tag}\n`;
  const start = changelog.indexOf(heading);
  if (start === -1) return undefined;
  const after = changelog.slice(start + heading.length);
  const sepIdx = after.indexOf("\n---\n");
  const nextHeadingIdx = after.indexOf("\n## ");
  const end =
    sepIdx === -1
      ? nextHeadingIdx === -1
        ? after.length
        : nextHeadingIdx
      : nextHeadingIdx === -1
        ? sepIdx
        : Math.min(sepIdx, nextHeadingIdx);
  return after.slice(0, end).trim();
}
