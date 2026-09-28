import { ProjectId, type PullRequestSummary, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import type { AnimationEvent } from "react";

import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  resolveThreadPullRequestBadgePresentation,
  synchronizeTerminalPulse,
} from "./ThreadStatusIndicators";
import { newestPullRequestSummary } from "../state/pullRequests";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

describe("synchronizeTerminalPulse", () => {
  it("pins only the status pulse to the document clock", () => {
    const pulse = { animationName: "status-pulse", startTime: 975 } as CSSAnimation;
    const otherCss = { animationName: "other-animation", startTime: 125 } as CSSAnimation;
    const otherAnimation = { startTime: 250 } as Animation;

    synchronizeTerminalPulse({
      animationName: "status-pulse",
      currentTarget: { getAnimations: () => [pulse, otherCss, otherAnimation] },
    } as AnimationEvent<SVGSVGElement>);

    expect([pulse.startTime, otherCss.startTime, otherAnimation.startTime]).toEqual([0, 125, 250]);
  });
});

describe("ChangeRequestStatusIcon", () => {
  it("uses the draft pull request glyph", () => {
    expect(ChangeRequestStatusIcon({ state: "open", isDraft: true }).type).toBe(
      PullRequestGlyph.draft,
    );
  });
});

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/current",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: {
      number: 42,
      title: "PR branch",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseRef: "main",
      headRef: "feature/current",
      state: "open",
    },
    ...overrides,
  };
}

function pullRequestSummary(
  state: PullRequestSummary["state"],
  updatedAt: string,
): PullRequestSummary {
  return {
    provider: "github",
    projectId: ProjectId.make("project-1"),
    repository: "pingdotgg/t3code",
    number: 42,
    title: "Feature PR",
    url: "https://github.com/pingdotgg/t3code/pull/42",
    state,
    headBranch: "feature/current",
    baseBranch: "main",
    updatedAt,
  };
}

describe("shared pull request state", () => {
  it("shows a panel-observed merge instead of an older sidebar summary", () => {
    const open = pullRequestSummary("open", "2026-09-03T01:00:00.000Z");
    const merged = pullRequestSummary("merged", "2026-09-03T01:01:00.000Z");

    expect(newestPullRequestSummary(open, merged)).toBe(merged);
  });

  it("never lets a stale open response regress a merged observation", () => {
    const merged = pullRequestSummary("merged", "2026-09-03T01:01:00.000Z");
    const staleOpen = pullRequestSummary("open", "2026-09-03T01:00:00.000Z");

    expect(newestPullRequestSummary(merged, staleOpen)).toBe(merged);
  });

  it("accepts a newer open state after a closed pull request is reopened", () => {
    const closed = pullRequestSummary("closed", "2026-09-03T01:00:00.000Z");
    const reopened = pullRequestSummary("open", "2026-09-03T01:01:00.000Z");

    expect(newestPullRequestSummary(closed, reopened)).toBe(reopened);
  });
});

describe("prStatusIndicator", () => {
  it("formats PR tooltips with number, uppercase status, and title", () => {
    expect(prStatusIndicator(status().pr, undefined)).toMatchObject({
      tooltip: "PR #42 - Open: PR branch",
      tooltipLead: "PR #42 - Open",
      tooltipTitle: "PR branch",
    });
  });

  it("uses gray and draft wording for draft pull requests", () => {
    const draftPr = status().pr;
    if (!draftPr) throw new Error("Expected pull request fixture");

    expect(prStatusIndicator({ ...draftPr, isDraft: true }, undefined)).toMatchObject({
      label: "PR draft",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltipLead: "PR #42 - Draft",
    });
  });
});

describe("resolveThreadPullRequestBadgePresentation", () => {
  const url = "https://github.com/pingdotgg/t3code/pull/42";

  it("returns the pending pull-request badge when no snapshot is available", () => {
    expect(
      resolveThreadPullRequestBadgePresentation({
        badge: null,
        number: 42,
        url,
        status: null,
      }),
    ).toEqual({
      Icon: PullRequestGlyph.pullRequest,
      toneClassName: "text-muted-foreground",
      label: "PR #42, status pending",
      text: 42,
    });
  });

  it("keeps the merged state for one linked pull request", () => {
    const fixture = status().pr;
    if (!fixture) throw new Error("Expected pull request fixture");
    const prStatus = prStatusIndicator({ ...fixture, state: "merged", isDraft: false }, undefined);
    if (!prStatus) throw new Error("Expected pull request status");

    expect(
      resolveThreadPullRequestBadgePresentation({
        badge: { kind: "pull-request", others: 0, state: "open" },
        number: fixture.number,
        url: fixture.url,
        status: prStatus,
      }),
    ).toEqual({
      Icon: PullRequestGlyph.merged,
      toneClassName: "text-violet-600 dark:text-violet-300/90",
      label: "PR #42 - Merged: PR branch",
      text: fixture.number,
    });
  });

  it("uses a layers badge with the draft stack tone without a link identity", () => {
    expect(
      resolveThreadPullRequestBadgePresentation({
        badge: { kind: "stack", layers: 3, state: "draft" },
        status: null,
      }),
    ).toEqual({
      Icon: PullRequestGlyph.stack,
      toneClassName: "text-zinc-500 dark:text-zinc-400/80",
      label: "Stack of 3 pull requests, draft",
      text: 3,
    });
  });

  it("draws the count of unrelated linked pull requests with their merged aggregate state", () => {
    const fixture = status().pr;
    if (!fixture) throw new Error("Expected pull request fixture");
    const closedStatus = prStatusIndicator(
      { ...fixture, state: "closed", isDraft: false },
      undefined,
    );
    if (!closedStatus) throw new Error("Expected pull request status");

    expect(
      resolveThreadPullRequestBadgePresentation({
        badge: { kind: "pull-request", others: 2, state: "merged" },
        number: fixture.number,
        url: fixture.url,
        status: closedStatus,
      }),
    ).toEqual({
      Icon: PullRequestGlyph.merged,
      toneClassName: "text-violet-600 dark:text-violet-300/90",
      label: "PR #42 - Closed: PR branch, and 2 more linked; overall merged",
      text: "+3",
    });
  });

  it("omits the control when neither a stack nor a linked identity can be shown", () => {
    expect(resolveThreadPullRequestBadgePresentation({ badge: null, status: null })).toBeNull();
  });
});
