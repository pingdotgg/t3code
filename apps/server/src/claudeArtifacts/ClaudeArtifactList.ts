import type { ClaudeArtifact } from "@t3tools/contracts";

/** What one Artifact tool `list` result says. Only the tool's own text is read, never the model's. */
export interface ClaudeArtifactListPage {
  /** False when the text has no list header: an error or some other reply. */
  readonly hasList: boolean;
  readonly artifacts: ReadonlyArray<ClaudeArtifact>;
  /** Item lines (`- ...`) that did not parse. */
  readonly skippedLines: number;
  readonly nextPageToken: string | undefined;
  /** The tool left items out and gave no page token to reach them. */
  readonly truncated: boolean;
}

// Claude Code's headers: "3 artifacts, ...", "Showing 200 of at least 201 artifacts, ...",
// and for an empty list "No published or shared artifacts yet."
const LIST_HEADER =
  /^(?:(?:Showing \d+ of (?:at least )?)?\d+ (?:published )?artifacts?\b|No [^\n]*artifacts[^\n]* yet\.)/im;
// Claude Code's footers for items a list left out.
const MORE_NOT_SHOWN =
  /^\((?:(?:At least )?\d+ more not shown\b|More may exist:|Not every artifact could be listed\b)/im;
const NEXT_PAGE = /\(More exist: pass `page_token` "([^"\s]+)"/;
// `- (mine, web page, pinned) Title — https://claude.ai/artifact/ID — updated 2026-11-18`
const ITEM =
  /^- \(([^)]*)\) (.+?) — (https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+)(?: — updated (\d{4}-\d{2}-\d{2}))?$/;
// Tags that describe ownership or state, or only tell the model what an item is not.
const NON_KIND_TAGS = new Set(["mine", "shared", "pinned"]);

function parseItem(line: string): ClaudeArtifact | undefined {
  const match = ITEM.exec(line);
  if (match === null) return undefined;
  const [, rawTags = "", rawTitle = "", url = "", updatedOn] = match;
  const tags = rawTags
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  const owner = tags[0];
  if (owner !== "mine" && owner !== "shared") return undefined;
  const title = rawTitle.trim();
  if (title.length === 0) return undefined;
  return {
    title,
    url,
    owner,
    kinds: tags.filter((tag) => !NON_KIND_TAGS.has(tag) && !tag.startsWith("not a ")),
    pinned: tags.includes("pinned"),
    ...(updatedOn === undefined ? {} : { updatedOn }),
  };
}

export function parseClaudeArtifactListPage(text: string): ClaudeArtifactListPage {
  const artifacts: ClaudeArtifact[] = [];
  let skippedLines = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) continue;
    const artifact = parseItem(line);
    if (artifact === undefined) skippedLines += 1;
    else artifacts.push(artifact);
  }
  const nextPageToken = NEXT_PAGE.exec(text)?.[1];
  return {
    hasList: LIST_HEADER.test(text),
    artifacts,
    skippedLines,
    nextPageToken,
    truncated: nextPageToken === undefined && MORE_NOT_SHOWN.test(text),
  };
}

/** Pages in order, deduplicated by URL (a page boundary can repeat an item). */
export function mergeClaudeArtifactListPages(pages: ReadonlyArray<ClaudeArtifactListPage>): {
  readonly artifacts: ReadonlyArray<ClaudeArtifact>;
  readonly skippedLines: number;
} {
  const byUrl = new Map<string, ClaudeArtifact>();
  let skippedLines = 0;
  for (const page of pages) {
    skippedLines += page.skippedLines;
    for (const artifact of page.artifacts) {
      if (!byUrl.has(artifact.url)) byUrl.set(artifact.url, artifact);
    }
  }
  return { artifacts: [...byUrl.values()], skippedLines };
}
