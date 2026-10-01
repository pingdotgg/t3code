import "../../index.css";

import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId, type ProjectListEntriesInput } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const entriesFixture = [
  { path: ".agents", kind: "directory" as const },
  { path: ".agents/skills", kind: "directory" as const },
  { path: ".agents/skills/ask-matt", kind: "directory" as const },
  { path: ".agents/skills/ask-matt/SKILL.md", kind: "file" as const },
  { path: ".agents/skills/creation-examples", kind: "directory" as const },
  { path: ".agents/skills/creation-examples/SKILL.md", kind: "file" as const },
  { path: "src", kind: "directory" as const },
  { path: "src/index.ts", kind: "file" as const },
];

const listFixture = async (input: ProjectListEntriesInput) => ({
  entries:
    input.directoryPath === undefined
      ? entriesFixture
      : entriesFixture.filter(
          (entry) =>
            entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === input.directoryPath,
        ),
  truncated: false,
});
const listEntries = vi.fn(listFixture);
vi.mock("~/environmentApi", () => ({
  ensureEnvironmentApi: () => ({
    projects: {
      listEntries,
      searchEntries: async () => ({
        entries: entriesFixture.filter((entry) => entry.path.includes("creation-")),
        truncated: false,
      }),
    },
  }),
}));

import FileBrowserPanel from "./FileBrowserPanel";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-files"),
  ThreadId.make("thread-files"),
);

function treeRow(): { shadow: ShadowRoot; rows: HTMLButtonElement[] } | null {
  const host = [...document.querySelectorAll("*")].find(
    (element) => element.shadowRoot?.querySelector("[data-file-tree-search-container]") != null,
  );
  if (!host?.shadowRoot) return null;
  const rows = [
    ...host.shadowRoot.querySelectorAll('button[data-type="item"]'),
  ] as HTMLButtonElement[];
  return { shadow: host.shadowRoot, rows };
}

function treeRowPaths(): string[] {
  const tree = treeRow();
  if (!tree) return [];
  return tree.rows.map((row) => row.getAttribute("data-item-path") ?? "");
}

describe("FileBrowserPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    listEntries.mockImplementation(listFixture);
  });

  it("filters the tree down to matches plus their ancestor chain", async () => {
    const screen = await render(
      <div style={{ height: 400, width: 700, overflow: "hidden" }}>
        <div className="flex h-full min-h-0 flex-col">
          <FileBrowserPanel
            environmentId={threadRef.environmentId}
            cwd="/repo/project"
            projectName="t3code"
            selectedPath={null}
            revealRequest={null}
            onOpenFile={vi.fn()}
          />
        </div>
      </div>,
    );
    try {
      await vi.waitFor(
        () => {
          expect(treeRowPaths()).toContain("src/");
        },
        { timeout: 10000 },
      );

      await page.getByRole("textbox", { name: "Filter workspace files" }).fill("creation-");

      await vi.waitFor(
        () => {
          const paths = treeRowPaths();
          // The match itself is visible…
          expect(paths.some((path) => path.includes("creation-examples"))).toBe(true);
          // A collapsed single-child chain still exposes its folder ancestry.
          expect(
            treeRow()?.rows.some(
              (row) =>
                row.dataset.itemType === "folder" &&
                row.dataset.itemPath?.startsWith(".agents/skills/"),
            ),
          ).toBe(true);
          // …while unrelated branches, including same-level siblings, leave.
          expect(paths.some((path) => path.includes("ask-matt"))).toBe(false);
          expect(paths.some((path) => path.startsWith("src"))).toBe(false);
        },
        { timeout: 10000 },
      );
      await page.getByRole("button", { name: "Clear file filter" }).click();
      await vi.waitFor(() => {
        expect(treeRowPaths()).toContain("src/");
        expect(treeRowPaths().some((path) => path.includes("creation-examples"))).toBe(false);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("loads collapsed folders on demand, keeps expansion through refresh, and uses compact regular rows", async () => {
    const screen = await render(
      <div className="flex h-96 w-96 flex-col">
        <FileBrowserPanel
          environmentId={threadRef.environmentId}
          cwd="/repo/lazy-files"
          projectName="t3code"
          selectedPath={null}
          revealRequest={null}
          onOpenFile={vi.fn()}
        />
      </div>,
    );
    try {
      await vi.waitFor(() => expect(treeRowPaths()).toContain("src/"));
      expect(listEntries).toHaveBeenCalledWith({ cwd: "/repo/lazy-files", directoryPath: "" });
      expect(treeRowPaths()).not.toContain("src/index.ts");
      expect(document.querySelector("[data-file-browser-panel]")?.textContent).not.toContain(
        " files",
      );
      const row = treeRow()!.rows.find((item) => item.dataset.itemPath === "src/")!;
      expect(getComputedStyle(row).fontWeight).toBe("400");
      row.click();
      await vi.waitFor(() => expect(treeRowPaths()).toContain("src/index.ts"));
      expect(listEntries).toHaveBeenCalledWith({ cwd: "/repo/lazy-files", directoryPath: "src" });
      await page.getByRole("button", { name: "Refresh workspace files" }).click();
      await vi.waitFor(() => {
        expect(treeRowPaths()).toContain("src/index.ts");
        expect(
          listEntries.mock.calls.filter(([input]) => input.directoryPath === "src").length,
        ).toBe(2);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("bounds expanded-folder requests and deduplicates repeated expansion while loads are pending", async () => {
    const folders = Array.from({ length: 6 }, (_, index) => `folder-${index}`);
    const finish: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    listEntries.mockImplementation(async (input) => {
      if (input.directoryPath === "") {
        return {
          entries: folders.map((path) => ({ path, kind: "directory" as const })),
          truncated: false,
        };
      }
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) =>
        finish.push(() => {
          active--;
          resolve();
        }),
      );
      return {
        entries: [{ path: `${input.directoryPath}/index.ts`, kind: "file" as const }],
        truncated: false,
      };
    });
    const screen = await render(
      <div className="flex h-96 w-96 flex-col">
        <FileBrowserPanel
          environmentId={threadRef.environmentId}
          cwd="/repo/bounded-files"
          projectName="t3code"
          selectedPath={null}
          revealRequest={null}
          onOpenFile={vi.fn()}
        />
      </div>,
    );
    try {
      await vi.waitFor(() => expect(treeRowPaths()).toContain("folder-0/"));
      await page.getByRole("button", { name: "Expand all folders" }).click();
      await vi.waitFor(() => expect(finish).toHaveLength(4));
      expect(listEntries).toHaveBeenCalledTimes(5);
      await page.getByRole("button", { name: "Collapse all folders" }).click();
      await page.getByRole("button", { name: "Expand all folders" }).click();
      expect(listEntries).toHaveBeenCalledTimes(5);
      finish.splice(0).forEach((resolve) => resolve());
      await vi.waitFor(() => expect(finish).toHaveLength(2));
      finish.splice(0).forEach((resolve) => resolve());
      await vi.waitFor(() =>
        expect(treeRowPaths().filter((path) => path.endsWith("index.ts"))).toHaveLength(6),
      );
      expect(peak).toBe(4);
      expect(listEntries).toHaveBeenCalledTimes(7);
    } finally {
      await screen.unmount();
      finish.forEach((resolve) => resolve());
    }
  });
});
