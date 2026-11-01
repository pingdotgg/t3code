import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId, RunId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { v2ThreadShell } from "./agents.testFixtures";
const openPrLink = vi.hoisted(() => vi.fn((event: MouseEvent) => event.preventDefault()));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: "connected" } }),
  useEnvironmentProviders: () => new Map(),
}));
vi.mock("../../state/entities", () => ({ useProject: () => ({ title: "Project" }) }));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => openPrLink }));
vi.mock("../ThreadStatusIndicators", () => ({
  useLinkedThreadPullRequest: () => null,
  prStatusIndicator: () => null,
  linkedPullRequestSnapshotStatus: () => null,
}));
vi.mock("../ui/preview-card", () => ({
  PreviewCard: ({ children }: { children: ReactNode }) => children,
  PreviewCardTrigger: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
// The chat preview popup portals out of the card; these tests cover the card itself.
vi.mock("@base-ui/react/preview-card", () => ({ PreviewCard: { Portal: () => null } }));
vi.mock("./AgentChatPreview", () => ({ AgentChatPreview: () => null }));
import { ThreadCard } from "./ThreadCard";
import type { AgentCardChildren } from "./agents.logic";

const renderCard = (ui: ReactNode) => {
  vi.clearAllMocks();
  return render(ui, { router: "/agents" });
};
describe("agent card PR navigation", () => {
  it.each(["linkedPullRequest", "branchPullRequest", "pullRequests"] as const)(
    "collapses %s behind a count and opens it even while PR details are unavailable",
    async (field) => {
      const reference = {
        projectId: ProjectId.make("project"),
        repository: "owner/repo",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      };
      const thread = {
        ...presentThreadShell(EnvironmentId.make("remote"), v2ThreadShell),
        id: ThreadId.make("chat"),
        environmentId: EnvironmentId.make("remote"),
        projectId: reference.projectId,
        title: "Agent chat",
        updatedAt: "2026-09-10T00:00:00Z",
        settledAt: null,
        ...(field === "pullRequests"
          ? {
              pullRequests: [42, 43].map((number) => ({
                host: "github.com",
                repository: "owner/repo",
                number,
                url: `https://github.com/owner/repo/pull/${number}`,
                source: "agent" as const,
                linkedAt: "2026-09-10T00:00:00Z",
                snapshot: null,
                stack: null,
              })),
            }
          : { [field]: reference }),
      } satisfies EnvironmentThreadShell;
      await using screen = await renderCard(<ThreadCard thread={thread} onContextMenu={vi.fn()} />);
      const { container } = screen;
      // Collapsed by default: only the count shows until the card is expanded.
      expect(container.querySelector(`a[href="${reference.url}"]`)).toBeNull();
      const toggle = container.querySelector<HTMLButtonElement>(".agent-thread-prs-toggle")!;
      expect(toggle.textContent).toBe(field === "pullRequests" ? "2 PRs" : "1 PR");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      await act(async () => toggle.click());
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      const link = container.querySelector<HTMLAnchorElement>(`a[href="${reference.url}"]`)!;
      expect(link).not.toBeNull();
      if (field === "pullRequests")
        expect(
          container.querySelector('a[href="https://github.com/owner/repo/pull/43"]'),
        ).not.toBeNull();
      await act(async () => link.click());
      expect(openPrLink).toHaveBeenCalledWith(
        expect.anything(),
        reference.url,
        undefined,
        thread.environmentId,
      );
      await act(async () => toggle.click());
      expect(container.querySelector(`a[href="${reference.url}"]`)).toBeNull();
    },
  );
});

describe("agent card linked chats", () => {
  const parent = presentThreadShell(EnvironmentId.make("remote"), v2ThreadShell);
  const child = (id: string, overrides: Partial<EnvironmentThreadShell> = {}) => ({
    thread: {
      ...parent,
      id: ThreadId.make(id),
      title: id,
      profileSnapshot: {
        profileId: "cody",
        profileName: "Cody",
        revision: 1,
        effectiveSource: {
          modelSelection: "profile",
          runtimeMode: "profile",
          interactionMode: "profile",
          reasoningEffort: "profile",
        },
      } satisfies EnvironmentThreadShell["profileSnapshot"],
      parentThreadId: parent.id,
      lineage: {
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        relationshipToParent: null,
      },
      ...overrides,
    },
    depth: 0,
    siblings: [],
  });
  const done = {
    latestRun: {
      runId: RunId.make("run"),
      status: "completed",
      requestedAt: "2026-09-10T00:00:00Z",
      startedAt: "2026-09-10T00:00:00Z",
      completedAt: "2026-09-10T00:01:00Z",
      assistantMessageId: null,
    },
  } satisfies Partial<EnvironmentThreadShell>;
  const runs: AgentCardChildren<EnvironmentThreadShell> = {
    live: [
      ...Array.from({ length: 20 }, (_, index) => child(`Finished worker ${index}`, done)),
      child("Running worker", {
        latestRun: { ...done.latestRun, status: "running", completedAt: null },
      }),
      child("Waiting worker", { hasPendingUserInput: true }),
    ],
    settled: [child("Settled worker", { settledAt: "2026-09-10T00:00:00Z" })],
  };

  it("collapses children to who is on them and their counts, then lists them", async () => {
    // The open state persists per device; start every run collapsed.
    localStorage.removeItem("t3code:sidebar:expanded-parents");
    await using screen = await renderCard(
      <ThreadCard thread={parent} childRuns={runs} onContextMenu={vi.fn()} />,
    );
    const { container } = screen;
    const summary = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-child-runs-toggle"]',
    )!;
    const titles = () =>
      [...container.querySelectorAll(".agent-thread-child-title")].map(
        (title) => title.textContent,
      );
    const button = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".agent-thread-children-toggle")].find(
        (candidate) => candidate.textContent?.startsWith(label),
      )!;
    const avatars = () => [...container.querySelectorAll<HTMLAnchorElement>(".agent-child-avatar")];
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.getAttribute("aria-label")).toBe(
      "23 child chats: 1 needs input · 1 running · 21 done",
    );
    expect(summary.textContent).toBe("1 needs input · 1 running · 21 done");
    expect(titles()).toHaveLength(0);
    // Most urgent first, capped at five, the rest as +N; none of them sit inside the toggle.
    expect(avatars().map((avatar) => avatar.getAttribute("aria-label"))).toEqual([
      "Cody · Waiting worker · Needs input",
      "Cody · Running worker · In progress",
      ...Array.from({ length: 3 }, (_, index) => `Cody · Finished worker ${index} · Done`),
    ]);
    expect(container.querySelector(".agent-child-avatars-more")?.textContent).toBe("+18");
    expect(avatars().some((avatar) => summary.contains(avatar))).toBe(false);
    await act(async () => avatars()[0]!.click());
    expect(decodeURIComponent(screen.router!.state.location.pathname)).toBe(
      `/agents/${parent.environmentId}/Waiting worker`,
    );
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    await act(async () => summary.click());
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(titles().slice(0, 2)).toEqual(["Waiting worker", "Running worker"]);
    expect(titles()).toHaveLength(8);
    expect(container.textContent).toContain("Cody");
    await act(async () => button("Show 14 more").click());
    expect(titles()).toHaveLength(22);
    await act(async () => button("Show less").click());
    expect(titles()).toHaveLength(8);
    expect(container.textContent).not.toContain("Settled worker");
    await act(async () => button("Settled children").click());
    expect(container.textContent).toContain("Settled worker");
    await act(async () => button("Settled children").click());
    expect(container.textContent).not.toContain("Settled worker");
    await act(async () => summary.click());
    expect(titles()).toHaveLength(0);
  });
});

describe("agent card settle action", () => {
  const topLevel = {
    ...presentThreadShell(EnvironmentId.make("remote"), v2ThreadShell),
    id: ThreadId.make("chat"),
    environmentId: EnvironmentId.make("remote"),
    title: "Agent chat",
    updatedAt: "2026-09-10T00:00:00Z",
    settledAt: null,
  } satisfies EnvironmentThreadShell;

  it("offers settle or un-settle only on top-level cards of servers that support it", async () => {
    const card = (thread: EnvironmentThreadShell, settleSupported = true) => (
      <ThreadCard
        thread={thread}
        settleSupported={settleSupported}
        onSettleAction={vi.fn()}
        onContextMenu={vi.fn()}
      />
    );
    const settleButtons = () =>
      [...screen.container.querySelectorAll(".agent-thread-settle")].map((button) =>
        button.getAttribute("aria-label"),
      );
    await using screen = await renderCard(card(topLevel));
    expect(settleButtons()).toEqual(["Settle chat"]);
    await screen.rerender(card({ ...topLevel, settledAt: "2026-09-10T00:05:00Z" }));
    expect(settleButtons()).toEqual(["Un-settle chat"]);
    await screen.rerender(card({ ...topLevel, parentThreadId: ThreadId.make("parent") }));
    expect(settleButtons()).toEqual([]);
    await screen.rerender(card(topLevel, false));
    expect(settleButtons()).toEqual([]);
  });
});
