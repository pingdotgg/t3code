import type { PostHogInboxSection, PostHogReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDoneSections,
  buildInboxSections,
  buildReportWork,
  EMPTY_INBOX_FILTER,
  isEmptyFilter,
  matchesFilter,
  nextCustomSectionId,
  SECTION_PAGE_SIZE,
  visibleSectionReports,
} from "./inboxSections.logic";

function report(overrides: Partial<Omit<PostHogReport, "id">> & { id: string }): PostHogReport {
  return {
    title: `Report ${overrides.id}`,
    summary: null,
    status: "ready",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    source_products: [],
    ...overrides,
  } as PostHogReport;
}

function section(overrides: Partial<PostHogInboxSection> & { id: string }): PostHogInboxSection {
  return {
    label: `Section ${overrides.id}`,
    collapsed: false,
    ...overrides,
    filter: { ...EMPTY_INBOX_FILTER, ...overrides.filter },
  } as PostHogInboxSection;
}

describe("inbox sections", () => {
  it("sections by whose move it is, not by who it was routed to", () => {
    const reports = [
      report({ id: "mine", is_suggested_reviewer: true }),
      report({ id: "theirs", is_suggested_reviewer: false }),
    ];

    const groups = buildInboxSections(reports, []);
    expect(groups.some((group) => group.id === "for-you")).toBe(false);
    expect(
      groups.find((group) => group.id === "needs-you")?.reports.map((entry) => entry.id),
    ).toEqual(["mine", "theirs"]);
  });

  it("narrows every section at once when the scope is For you", () => {
    const reports = [
      report({ id: "mine", is_suggested_reviewer: true }),
      report({ id: "theirs", is_suggested_reviewer: false }),
    ];
    const scoped = buildInboxSections(reports, [], { scope: "for-you" }).flatMap(
      (group) => group.reports,
    );
    expect(scoped.map((entry) => entry.id)).toEqual(["mine"]);
  });

  it("keeps work you started in view whoever the report was routed to", () => {
    const reports = [report({ id: "unrouted", is_suggested_reviewer: false })];
    const work = buildReportWork([{ reportId: "unrouted", archivedAt: null, session: null }]);
    const groups = buildInboxSections(reports, [], { scope: "for-you", work });
    expect(
      groups.find((group) => group.id === "working")?.reports.map((entry) => entry.id),
    ).toEqual(["unrouted"]);
  });

  it("separates work running here from a report merely waiting", () => {
    const reports = [report({ id: "live" }), report({ id: "idle" })];
    const work = buildReportWork([
      { reportId: "live", archivedAt: null, session: { status: "running" } },
    ]);
    const groups = buildInboxSections(reports, [], { work });
    const ids = (id: string) =>
      groups.find((group) => group.id === id)?.reports.map((entry) => entry.id) ?? [];

    expect(ids("working")).toEqual(["live"]);
    expect(ids("needs-you")).toEqual(["idle"]);
  });

  it("counts a pull request opened here as in review", () => {
    const work = buildReportWork([
      {
        reportId: "local-pr",
        archivedAt: null,
        session: null,
        linkedPullRequest: { url: "https://github.com/x/y/pull/9" },
      },
    ]);
    const groups = buildInboxSections([report({ id: "local-pr" })], [], { work });
    expect(
      groups.find((group) => group.id === "in-review")?.reports.map((entry) => entry.id),
    ).toEqual(["local-pr"]);
  });

  it("ignores archived conversations when reading local work", () => {
    const work = buildReportWork([
      { reportId: "old", archivedAt: "2026-01-01T00:00:00Z", session: { status: "running" } },
    ]);
    expect(work.get("old")).toBeUndefined();
  });

  it("puts a running report at the top of its section", () => {
    const reports = [
      report({ id: "newer", updated_at: "2026-03-01T00:00:00Z" }),
      report({ id: "running", updated_at: "2026-01-01T00:00:00Z" }),
    ];
    const work = buildReportWork([
      { reportId: "running", archivedAt: null, session: { status: "running" } },
      { reportId: "newer", archivedAt: null, session: null },
    ]);
    const groups = buildInboxSections(reports, [], { work });
    expect(
      groups.find((group) => group.id === "working")?.reports.map((entry) => entry.id),
    ).toEqual(["running", "newer"]);
  });

  it("keeps a report in exactly one section", () => {
    const reports = [report({ id: "a", is_suggested_reviewer: true })];
    const placements = buildInboxSections(reports, []).filter((group) => group.reports.length > 0);
    expect(placements).toHaveLength(1);
  });

  it("lets a custom section outrank a built-in one", () => {
    const reports = [report({ id: "p0", priority: "P0" }), report({ id: "p3", priority: "P3" })];
    const custom = section({
      id: "my-p0s",
      label: "My P0s",
      filter: { ...EMPTY_INBOX_FILTER, priorities: ["P0"] },
    });

    const groups = buildInboxSections(reports, [custom]);
    expect(groups[0]?.id).toBe("my-p0s");
    expect(groups[0]?.reports.map((entry) => entry.id)).toEqual(["p0"]);
    expect(
      groups.find((group) => group.id === "needs-you")?.reports.map((entry) => entry.id),
    ).toEqual(["p3"]);
  });

  it("collects unclaimed reports into Everything else rather than dropping them", () => {
    const groups = buildInboxSections([report({ id: "odd", status: "some_new_status" })], []);
    expect(groups.at(-1)?.id).toBe("everything-else");
    expect(groups.at(-1)?.reports.map((entry) => entry.id)).toEqual(["odd"]);
  });

  it("omits Everything else when every report was claimed", () => {
    const groups = buildInboxSections([report({ id: "a" })], []);
    expect(groups.some((group) => group.id === "everything-else")).toBe(false);
  });

  it("leaves closed reports to the Done view", () => {
    const reports = [
      report({ id: "open" }),
      report({ id: "archived", status: "suppressed" }),
      report({ id: "resolved", status: "resolved" }),
    ];

    const open = buildInboxSections(reports, []).flatMap((group) => group.reports);
    expect(open.map((entry) => entry.id)).toEqual(["open"]);
    expect(buildDoneSections(reports)[0]?.reports.map((entry) => entry.id)).toEqual([
      "archived",
      "resolved",
    ]);
  });

  it("sorts each section newest first", () => {
    const reports = [
      report({ id: "old", updated_at: "2026-01-01T00:00:00Z" }),
      report({ id: "new", updated_at: "2026-02-01T00:00:00Z" }),
    ];
    const groups = buildInboxSections(reports, []);
    expect(
      groups.find((group) => group.id === "needs-you")?.reports.map((entry) => entry.id),
    ).toEqual(["new", "old"]);
  });

  it("keeps an already-handled report out of the decision sections", () => {
    const reports = [
      report({ id: "handled", already_addressed: true, is_suggested_reviewer: true }),
      report({ id: "open" }),
    ];
    const groups = buildInboxSections(reports, []);
    const ids = (id: string) =>
      groups.find((group) => group.id === id)?.reports.map((entry) => entry.id) ?? [];

    expect(ids("needs-you")).toEqual(["open"]);
    expect(ids("already-handled")).toEqual(["handled"]);
  });

  it("opens the already-handled section folded, and the decision ones open", () => {
    const groups = buildInboxSections([report({ id: "handled", already_addressed: true })], []);
    const collapsed = (id: string) =>
      groups.find((group) => group.id === id)?.defaultCollapsed ?? null;
    expect(collapsed("already-handled")).toBe(true);
    expect(collapsed("needs-you")).toBe(false);
  });

  it("prefers In flight over Already handled when there is a pull request to read", () => {
    const reports = [
      report({
        id: "both",
        already_addressed: true,
        implementation_pr_url: "https://github.com/x/y/pull/1",
      }),
    ];
    const groups = buildInboxSections(reports, []);
    expect(
      groups.find((group) => group.id === "in-review")?.reports.map((entry) => entry.id),
    ).toEqual(["both"]);
    expect(groups.find((group) => group.id === "already-handled")?.reports).toEqual([]);
  });

  it("hides not-actionable reports unless they are asked for", () => {
    const reports = [
      report({ id: "nothing", actionability: "not_actionable" }),
      report({ id: "real", actionability: "immediately_actionable" }),
    ];

    const hidden = buildInboxSections(reports, []).flatMap((group) => group.reports);
    expect(hidden.map((entry) => entry.id)).toEqual(["real"]);

    const shown = buildInboxSections(reports, [], { showNotActionable: true });
    expect(
      shown.find((group) => group.id === "not-actionable")?.reports.map((entry) => entry.id),
    ).toEqual(["nothing"]);
  });

  it("keeps an unjudged report even though it has no actionability", () => {
    // The server-side actionability filter would drop these; the client-side
    // rule must not, or every report still being researched disappears.
    const groups = buildInboxSections([report({ id: "researching", status: "in_progress" })], []);
    expect(
      groups.find((group) => group.id === "agent-working")?.reports.map((entry) => entry.id),
    ).toEqual(["researching"]);
  });

  it("puts a report with an open pull request in flight, not in Needs a decision", () => {
    const reports = [report({ id: "pr", implementation_pr_url: "https://github.com/x/y/pull/1" })];
    const groups = buildInboxSections(reports, []);
    expect(
      groups.find((group) => group.id === "in-review")?.reports.map((entry) => entry.id),
    ).toEqual(["pr"]);
  });
});

describe("failed runs", () => {
  it("asks the reader to clear a failed run rather than folding it away", () => {
    const groups = buildInboxSections([report({ id: "dead", status: "failed" })], []);
    expect(
      groups.find((group) => group.id === "needs-you")?.reports.map((entry) => entry.id),
    ).toEqual(["dead"]);
    expect(groups.find((group) => group.id === "agent-working")?.reports ?? []).toEqual([]);
  });
});

describe("section paging", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => report({ id: `r${index}` }));

  it("shows everything when a section fits", () => {
    const result = visibleSectionReports(many(3));
    expect(result.visible).toHaveLength(3);
    expect(result.hiddenCount).toBe(0);
    expect(result.nextRevealCount).toBe(0);
  });

  it("caps a long section and says how many it held back", () => {
    const result = visibleSectionReports(many(25));
    expect(result.visible).toHaveLength(SECTION_PAGE_SIZE);
    expect(result.hiddenCount).toBe(25 - SECTION_PAGE_SIZE);
    expect(result.nextRevealCount).toBe(SECTION_PAGE_SIZE);
  });

  it("reveals a page at a time rather than the whole tail", () => {
    const result = visibleSectionReports(many(200), SECTION_PAGE_SIZE * 2);
    expect(result.visible).toHaveLength(SECTION_PAGE_SIZE * 2);
    expect(result.nextRevealCount).toBe(SECTION_PAGE_SIZE);
  });

  it("offers only what is left on the last page", () => {
    const result = visibleSectionReports(many(13), 10);
    expect(result.nextRevealCount).toBe(3);
  });

  it("survives a limit past the end", () => {
    const result = visibleSectionReports(many(4), 999);
    expect(result.visible).toHaveLength(4);
    expect(result.hiddenCount).toBe(0);
  });
});

describe("inbox filters", () => {
  it("treats an empty filter as keeping everything", () => {
    expect(isEmptyFilter(EMPTY_INBOX_FILTER)).toBe(true);
    expect(matchesFilter(report({ id: "a" }), EMPTY_INBOX_FILTER)).toBe(true);
  });

  it("matches a report carrying any of the filter's source products", () => {
    const filter = { ...EMPTY_INBOX_FILTER, sourceProducts: ["error_tracking", "zendesk"] };
    expect(matchesFilter(report({ id: "a", source_products: ["error_tracking"] }), filter)).toBe(
      true,
    );
    expect(matchesFilter(report({ id: "b", source_products: ["conversations"] }), filter)).toBe(
      false,
    );
  });

  it("matches titles case-insensitively", () => {
    const filter = { ...EMPTY_INBOX_FILTER, titleContains: "BILLING" };
    expect(matchesFilter(report({ id: "a", title: "fix(billing): thing" }), filter)).toBe(true);
    expect(matchesFilter(report({ id: "b", title: "fix(docs): thing" }), filter)).toBe(false);
  });

  it("distinguishes an absent flag from an explicit false", () => {
    const routed = report({ id: "a", is_suggested_reviewer: true });
    const unrouted = report({ id: "b", is_suggested_reviewer: false });
    expect(matchesFilter(routed, { ...EMPTY_INBOX_FILTER, forYou: true })).toBe(true);
    expect(matchesFilter(unrouted, { ...EMPTY_INBOX_FILTER, forYou: true })).toBe(false);
    expect(matchesFilter(unrouted, { ...EMPTY_INBOX_FILTER, forYou: false })).toBe(true);
    expect(matchesFilter(routed, EMPTY_INBOX_FILTER)).toBe(true);
  });

  it("mints ids that avoid built-in and existing section names", () => {
    const existing = [section({ id: "section-1" })];
    expect(nextCustomSectionId(existing)).not.toBe("section-1");
    expect(nextCustomSectionId([])).toBe("section-1");
  });
});
