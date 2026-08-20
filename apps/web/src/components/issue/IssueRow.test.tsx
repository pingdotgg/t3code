import type { IssueListEntry } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { IssueRow } from "./IssueRow";

const entry = {
  provider: "github",
  host: "github.com",
  projectId: "project-1" as IssueListEntry["projectId"],
  projectTitle: "T3 Code",
  repository: "pingdotgg/t3code",
  number: 6368,
  title: "Keep narrow issue rows readable",
  url: "https://github.com/pingdotgg/t3code/issues/6368",
  author: { login: "long-author-name", name: null, avatarUrl: null },
  state: "open",
  stateReason: null,
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T01:00:00Z",
  closedAt: null,
  assignees: [],
  labels: [],
  milestone: null,
  commentCount: 0,
} as IssueListEntry;

describe("IssueRow", () => {
  it("keeps narrow metadata inside its grid column", () => {
    const markup = renderToStaticMarkup(
      <IssueRow
        entry={entry}
        selected={false}
        selectionChecked={false}
        showProjectTitle={false}
        showProvider={false}
        onSelect={() => undefined}
        onToggleSelection={() => undefined}
      />,
    );

    expect(markup).toContain("mt-0.5 overflow-hidden text-xs");
    expect(markup).toContain('class="flex min-w-0 items-center gap-1.5 max-w-40"');
    expect(markup).not.toContain(" title=");
  });

  it("offers a checkbox without covering the status glyph", () => {
    const props = {
      entry,
      selected: false,
      selectionChecked: false,
      showProjectTitle: false,
      showProvider: false,
      onSelect: () => undefined,
      onToggleSelection: () => undefined,
    };
    const markup = renderToStaticMarkup(<IssueRow {...props} />);

    expect(markup).toContain('aria-label="Select pingdotgg/t3code issue #6368"');
    expect(markup).toContain("group-hover/row:opacity-100");
    expect(markup).toContain("[&amp;&gt;button]:pl-10");
    expect(markup.indexOf('aria-label="Select pingdotgg/t3code issue #6368"')).toBeGreaterThan(
      markup.indexOf("</button>"),
    );
  });

  it("shows the selected reaction count while sorting by reactions", () => {
    const markup = renderToStaticMarkup(
      <IssueRow
        entry={{
          ...entry,
          commentCount: 9,
          reactions: [{ content: "rocket", count: 3, actors: [], viewerHasReacted: false }],
        }}
        selected={false}
        selectionChecked={false}
        showProjectTitle={false}
        showProvider={false}
        reactionSort="reactions-rocket"
        onSelect={() => undefined}
        onToggleSelection={() => undefined}
      />,
    );

    expect(markup).toContain("3 reactions");
    expect(markup).not.toContain("9 comments");
  });
});
