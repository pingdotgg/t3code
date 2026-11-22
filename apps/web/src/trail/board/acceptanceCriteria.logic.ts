/**
 * Acceptance criteria live in the issue body as a Markdown task list under a
 * heading whose text matches /acceptance criteria/i (FORK_PLAN). Not a GitHub field.
 */

export type AcceptanceCriterion = {
  readonly text: string;
  readonly checked: boolean;
};

export type AcceptanceCriteriaSection = {
  readonly heading: string;
  readonly items: ReadonlyArray<AcceptanceCriterion>;
};

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;

function isAcceptanceHeading(title: string): boolean {
  return /acceptance\s+criteria/i.test(title);
}

/**
 * Find the first "Acceptance criteria" heading and collect task-list items until
 * the next heading of equal or higher rank (or end of body).
 */
export function parseAcceptanceCriteria(
  body: string | null | undefined,
): AcceptanceCriteriaSection | null {
  if (body == null || body.trim().length === 0) return null;

  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let headingIndex = -1;
  let headingLevel = 0;
  let headingText = "";

  for (let i = 0; i < lines.length; i++) {
    const match = HEADING_RE.exec(lines[i]!);
    if (!match) continue;
    const title = match[2]!.trim();
    if (!isAcceptanceHeading(title)) continue;
    headingIndex = i;
    headingLevel = match[1]!.length;
    headingText = title;
    break;
  }

  if (headingIndex < 0) return null;

  const items: AcceptanceCriterion[] = [];
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const nextHeading = HEADING_RE.exec(line);
    if (nextHeading && nextHeading[1]!.length <= headingLevel) break;

    const task = TASK_RE.exec(line);
    if (!task) continue;
    const text = task[3]!.trim();
    if (!text) continue;
    items.push({
      text,
      checked: task[2]!.toLowerCase() === "x",
    });
  }

  return { heading: headingText, items };
}
