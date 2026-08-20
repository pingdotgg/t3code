import type { EnvironmentId, ProjectId, WorkItemMatch } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { workItemMatchCacheKey, WorkItemMatchButton, WorkItemMatchRows } from "./WorkItemMatches";

const match = {
  kind: "pull-request",
  provider: "github",
  repository: "acme/app",
  number: 34,
  title: "Refresh active sessions",
  url: "https://github.com/acme/app/pull/34",
  confidence: "high",
  reason: "Implements the session refresh requested here.",
} satisfies WorkItemMatch;

describe("work item matches", () => {
  it("keeps equal references from different servers and providers in separate caches", () => {
    const base = {
      projectId: "project-a" as ProjectId,
      source: {
        kind: "issue" as const,
        repository: "ENG",
        number: 12,
      },
      version: "2026-08-20T10:00:00Z",
    };

    expect(
      new Set([
        workItemMatchCacheKey({
          ...base,
          environmentId: "local" as EnvironmentId,
          source: { ...base.source, provider: "linear" },
        }),
        workItemMatchCacheKey({
          ...base,
          environmentId: "remote" as EnvironmentId,
          source: { ...base.source, provider: "linear" },
        }),
        workItemMatchCacheKey({
          ...base,
          environmentId: "local" as EnvironmentId,
          source: { ...base.source, provider: "github" },
        }),
      ]).size,
    ).toBe(3);
  });

  it("shows progress while AI is finding matches", () => {
    const markup = renderToStaticMarkup(
      <WorkItemMatchButton busy loaded={false} onClick={() => undefined} />,
    );

    expect(markup).toContain("Finding...");
  });

  it("shows trusted match details and confidence", () => {
    const markup = renderToStaticMarkup(
      <WorkItemMatchRows
        matches={[match]}
        emptyText="No likely matches found."
        onOpen={() => undefined}
      />,
    );

    expect(markup).toContain("Refresh active sessions");
    expect(markup).toContain("Implements the session refresh requested here.");
    expect(markup).toContain("High confidence");
    expect(markup).not.toContain("Link with agent");
  });

  it("offers agent linking on each actionable AI match", () => {
    const markup = renderToStaticMarkup(
      <WorkItemMatchRows
        matches={[match]}
        emptyText="No likely matches found."
        onOpen={() => undefined}
        onLink={() => undefined}
      />,
    );

    expect(markup).toContain("Link with agent");
  });

  it("shows a clear empty result", () => {
    const markup = renderToStaticMarkup(
      <WorkItemMatchRows
        matches={[]}
        emptyText="No likely duplicate issues found."
        onOpen={() => undefined}
      />,
    );

    expect(markup).toContain("No likely duplicate issues found.");
  });
});
