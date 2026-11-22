import type { SkillsLibraryStatus } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export interface SkillsLibraryIssue {
  readonly key: string;
  readonly name: string;
  readonly kind: string;
  readonly paths: readonly string[];
  readonly guidance: string;
}

export function skillsLibraryIssues(
  status: SkillsLibraryStatus,
  resolve: MFunctionType = mFallback,
): SkillsLibraryIssue[] {
  return [
    ...status.conflicts.map((conflict) =>
      conflict.reason === "outsideLink"
        ? {
            key: `conflict:${conflict.name}`,
            name: conflict.name,
            kind: resolve(msg("Link outside the skill")),
            paths: conflict.paths,
            guidance: resolve(
              msg(
                "The second path is a link inside the skill whose target lies outside it. Replace the link with the file before refreshing.",
              ),
            ),
          }
        : {
            key: `conflict:${conflict.name}`,
            name: conflict.name,
            kind: resolve(msg("Copies differ")),
            paths: conflict.paths,
            guidance: resolve(msg("These copies differ. Keep one copy before refreshing.")),
          },
    ),
    ...status.nameMismatches.map((mismatch) => ({
      key: `name:${mismatch.name}`,
      name: mismatch.name,
      kind: resolve(msg('Named "{name}" in SKILL.md', { name: mismatch.frontmatterName })),
      paths: [],
      guidance: resolve(
        msg('Some providers use the folder name and others use "{name}".', {
          name: mismatch.frontmatterName,
        }),
      ),
    })),
  ];
}

export function skillsLibraryIssueSummary(
  status: SkillsLibraryStatus,
  resolve: MFunctionType = mFallback,
): string | null {
  const parts = [
    status.conflicts.length === 0
      ? null
      : resolve(
          msg("{count, plural, one {{count} conflict} other {{count} conflicts}}", {
            count: status.conflicts.length,
          }),
        ),
    status.nameMismatches.length === 0
      ? null
      : resolve(
          msg("{count, plural, one {{count} name mismatch} other {{count} name mismatches}}", {
            count: status.nameMismatches.length,
          }),
        ),
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

export function filterSkillsLibraryIssues(
  issues: readonly SkillsLibraryIssue[],
  query: string,
): readonly SkillsLibraryIssue[] {
  const needle = query.trim().toLowerCase();
  return needle
    ? issues.filter((issue) =>
        [issue.name, issue.kind, ...issue.paths].some((text) =>
          text.toLowerCase().includes(needle),
        ),
      )
    : issues;
}
