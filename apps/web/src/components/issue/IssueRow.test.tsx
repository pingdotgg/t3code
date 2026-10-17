// @vitest-environment jsdom

import { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { compile } from "tailwindcss";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { IssueRow, type EnvironmentIssueEntry } from "./IssueRow";

const compactDisplayStyles = (await compile("@tailwind utilities;")).build([
  "flex",
  "inline-flex",
  "hidden",
]);
const entry: EnvironmentIssueEntry = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "org/repo",
  key: "1",
  displayKey: "#1",
  title: "A labeled issue",
  url: "https://github.com/org/repo/issues/1",
  author: null,
  state: { category: "open", name: "open" },
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
  labels: ["bug", "urgent", "web"].map((name) => ({ name, color: null })),
  assignees: [],
  commentCount: 0,
  closedAt: null,
};
let container: HTMLDivElement;
let root: Root;
let styles: HTMLStyleElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  styles = document.createElement("style");
  styles.textContent = compactDisplayStyles;
  document.head.append(styles);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  styles.remove();
  vi.unstubAllGlobals();
});
const visibleLabels = () =>
  [...container.querySelectorAll<HTMLElement>('[data-slot="badge"]')]
    .filter((badge) => {
      for (let element: HTMLElement | null = badge; element; element = element.parentElement) {
        if (getComputedStyle(element).display === "none") return false;
      }
      return true;
    })
    .map((badge) => badge.textContent);

it("keeps the first label and remaining count visible in compact rows as labels change", async () => {
  const select = vi.fn();
  const render = (current: EnvironmentIssueEntry) =>
    act(async () =>
      root.render(
        <IssueRow
          entry={current}
          selected={false}
          showScope={false}
          showTracker={false}
          onSelect={select}
        />,
      ),
    );
  await render(entry);
  expect(visibleLabels()).toEqual(["bug+2"]);
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(select).toHaveBeenCalledExactlyOnceWith(entry);
  await render({ ...entry, labels: entry.labels.slice(0, 1) });
  expect(visibleLabels()).toEqual(["bug"]);
  await render({ ...entry, labels: [] });
  expect(visibleLabels()).toEqual([]);
});

it.each([false, true])(
  "shows current project names across rows (showScope=%s)",
  async (showScope) => {
    const select = vi.fn();
    const first = { ...entry, projectTitle: "Web workspace" };
    const second = {
      ...entry,
      projectId: ProjectId.make("second-project"),
      projectTitle: "API workspace",
      scope: "org/api",
    };
    const render = (current: EnvironmentIssueEntry) =>
      act(async () =>
        root.render(
          <>
            {[current, second].map((row) => (
              <IssueRow
                key={row.scope}
                entry={row}
                selected={false}
                showScope={showScope}
                showTracker
                environmentLabel="Remote"
                onSelect={select}
              />
            ))}
          </>,
        ),
      );
    await render(first);
    const rows = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(rows()[0]!.textContent).toContain("Web workspace");
    expect(rows()[1]!.textContent).toContain("API workspace");
    const rebound = { ...first, projectId: second.projectId, projectTitle: "New representative" };
    await render(rebound);
    expect(rows()[0]!.textContent).toContain("New representative");
    expect(container.textContent).not.toContain("Web workspace");
    expect(rows()[1]!.textContent).toContain("API workspace");
    await act(async () => rows()[0]!.click());
    expect(select).toHaveBeenCalledExactlyOnceWith(rebound);
  },
);

it.each([
  ["not-planned", "canceled", "Closed as not planned"],
  ["completed", "completed", "Closed as completed"],
] as const)(
  "names native close reason %s in the row glyph",
  async (closeReason, workflowCategory, label) => {
    await act(async () =>
      root.render(
        <IssueRow
          entry={{
            ...entry,
            state: { category: "closed", name: "closed", workflowCategory, closeReason },
          }}
          selected={false}
          showScope={false}
          showTracker={false}
          onSelect={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(label);
  },
);
