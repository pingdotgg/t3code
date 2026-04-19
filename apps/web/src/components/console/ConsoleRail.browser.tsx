import "../../index.css";

import { EnvironmentId, ThreadId } from "@workbench/contracts";
import { OrchestrationProposedPlanId, TurnId as MakeTurnId } from "@workbench/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

// ----- mocks -----
//
// Stub the live-environment integrations so the test only exercises the
// rail's stack/visibility/takeover behaviors.

// Per-test override for the file-read query response. Tests that exercise
// markdown preview / edit set this to a fake `{ contents, truncated }` so the
// viewer renders content instead of the empty state.
let mockReadFileResponse: { contents: string; relativePath: string; truncated: boolean } | null =
  null;

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn((options: { queryKey?: ReadonlyArray<unknown> }) => {
      // Inspect the queryKey shape to decide what to return. The read-file
      // query key starts with `["projects", "read-file", ...]` — see
      // `projectQueryKeys.readFile` in `lib/projectReactQuery.ts`.
      const key = options?.queryKey;
      if (
        Array.isArray(key) &&
        key[0] === "projects" &&
        key[1] === "read-file" &&
        mockReadFileResponse
      ) {
        return {
          data: mockReadFileResponse,
          error: null,
          isLoading: false,
          isError: false,
          refetch: vi.fn(() => Promise.resolve()),
        };
      }
      return {
        data: undefined,
        error: null,
        isLoading: false,
        isError: false,
        refetch: vi.fn(() => Promise.resolve()),
      };
    }),
  };
});

vi.mock("~/components/ui/toast", () => ({
  toastManager: {
    add: vi.fn(),
    close: vi.fn(),
    promise: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("~/localApi", () => ({
  readLocalApi: vi.fn(() => null),
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
}));

// Per-test stub for the environment API. Tests that exercise the save flow
// reassign this so the rail's `saveWorkspaceFile` finds a writeFile method.
let environmentApiStub: { projects: { writeFile: ReturnType<typeof vi.fn> } } | null = null;

vi.mock("~/environmentApi", () => ({
  readEnvironmentApi: vi.fn(() => environmentApiStub),
  ensureEnvironmentApi: vi.fn(() => {
    throw new Error("ensureEnvironmentApi not implemented in browser test");
  }),
  createEnvironmentApi: vi.fn(),
  __setEnvironmentApiOverrideForTests: vi.fn(),
  __resetEnvironmentApiOverridesForTests: vi.fn(),
}));

vi.mock("~/editorPreferences", () => ({
  openInPreferredEditor: vi.fn(() => Promise.resolve()),
}));

const { default: ConsoleRail } = await import("./ConsoleRail");

// ----- shared fixtures -----

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-console-rail-test");
const VISIBILITY_KEY = "workbench:console:pane-visibility:v1";
const COLLAPSED_KEY = "workbench:console:pane-collapsed:v1";

type RailProps = React.ComponentProps<typeof ConsoleRail>;

function defaultProps(overrides?: Partial<RailProps>): RailProps {
  return {
    open: true,
    mode: "sidebar",
    environmentId: ENVIRONMENT_ID,
    threadId: THREAD_ID,
    workspaceRoot: undefined,
    markdownCwd: undefined,
    resolvedTheme: "dark",
    timestampFormat: "locale",
    artifacts: [],
    workEntries: [],
    activePlan: null,
    activeProposedPlan: null,
    turnDiffSummaries: [],
    inferredCheckpointTurnCountByTurnId: {},
    expanded: false,
    onToggleExpanded: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

async function mountRail(overrides?: Partial<RailProps>) {
  const props = defaultProps(overrides);
  const host = document.createElement("div");
  host.style.cssText = "width: 480px; height: 720px; display: flex;";
  document.body.append(host);

  const screen = await render(<ConsoleRail {...props} />, { container: host });

  return {
    screen,
    props,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
    [Symbol.asyncDispose]: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function visiblePaneIds(): Array<"tree" | "recent" | "task"> {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]"))
    .map((el) => el.getAttribute("data-pane-id") as "tree" | "recent" | "task")
    .filter(
      (id): id is "tree" | "recent" | "task" => id === "tree" || id === "recent" || id === "task",
    );
}

function viewerOverlayCount(): number {
  return document.querySelectorAll("[data-viewer-overlay]").length;
}

// ----- behavior tests -----

describe("ConsoleRail (vertical stack model)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.localStorage.clear();
    environmentApiStub = null;
    mockReadFileResponse = null;
    vi.clearAllMocks();
  });

  it("defaults to Files, Recent edited files, and Tasks in the stack", async () => {
    await using _ = await mountRail();
    await vi.waitFor(() => {
      expect(visiblePaneIds()).toEqual(["tree", "recent", "task"]);
    });
  });

  it("Console badge menu opens with checkbox entries for each pane", async () => {
    await using _ = await mountRail();
    await page.getByLabelText("Add or remove console panes").click();
    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Files");
      expect(text).toContain("Recent edited files");
      expect(text).toContain("Tasks");
    });
  });

  it("checking Tasks in the menu adds it to the stack below Files", async () => {
    window.localStorage.setItem(
      VISIBILITY_KEY,
      JSON.stringify({ tree: true, recent: false, task: false }),
    );
    await using _ = await mountRail();
    await page.getByLabelText("Add or remove console panes").click();
    // The menu item label is just the pane name.
    await page.getByRole("menuitemcheckbox", { name: /Tasks/ }).click();

    await vi.waitFor(() => {
      const ids = visiblePaneIds();
      expect(ids).toEqual(["tree", "task"]);
    });
  });

  it("each card has its own X that removes only that card from the stack", async () => {
    // Seed Files + Tasks visible.
    window.localStorage.setItem(
      VISIBILITY_KEY,
      JSON.stringify({ tree: true, recent: false, task: true }),
    );

    await using _ = await mountRail();
    await page.getByLabelText("Close Tasks card").click();

    await vi.waitFor(() => {
      expect(visiblePaneIds()).toEqual(["tree"]);
    });
  });

  it("each card has a chevron that toggles its body collapsed state", async () => {
    await using _ = await mountRail();

    // Initially expanded — its body is rendered.
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-pane-id="tree"][data-pane-collapsed="false"]'),
      ).not.toBeNull();
    });

    await page.getByLabelText("Collapse Files card").click();

    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-pane-id="tree"][data-pane-collapsed="true"]'),
      ).not.toBeNull();
    });
  });

  it("collapse state persists in localStorage and rehydrates on remount", async () => {
    {
      await using first = await mountRail();
      // The card title is the workspace folder name; with workspaceRoot
      // unset it falls back to the literal "Files" label.
      await page.getByLabelText("Collapse Files card").click();
      await vi.waitFor(() => {
        const stored = window.localStorage.getItem(COLLAPSED_KEY);
        expect(stored).not.toBeNull();
        const parsed = JSON.parse(stored!) as Record<string, boolean>;
        expect(parsed.tree).toBe(true);
      });
      await first.cleanup();
    }
    {
      await using _ = await mountRail();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-pane-id="tree"][data-pane-collapsed="true"]'),
        ).not.toBeNull();
      });
    }
  });

  it("the Recent edited files card appears in the Console menu and can be added to the stack", async () => {
    window.localStorage.setItem(
      VISIBILITY_KEY,
      JSON.stringify({ tree: true, recent: false, task: false }),
    );
    await using _ = await mountRail();
    await page.getByLabelText("Add or remove console panes").click();
    await page.getByRole("menuitemcheckbox", { name: /Recent edited files/ }).click();
    await vi.waitFor(() => {
      expect(visiblePaneIds()).toContain("recent");
    });
  });

  it("stack can never go empty — closing the last card forces Files back on", async () => {
    window.localStorage.setItem(
      VISIBILITY_KEY,
      JSON.stringify({ tree: true, recent: false, task: false }),
    );
    await using _ = await mountRail();
    await page.getByLabelText("Close Files card").click();
    await vi.waitFor(() => {
      const ids = visiblePaneIds();
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toContain("tree");
    });
  });

  it("Expand affordance lives on the viewer takeover (not the rail header) and calls onToggleExpanded", async () => {
    // The expand button is intentionally NOT in the rail header — there's no
    // reason to make a stack of cards full-width. It belongs to the viewer,
    // which IS the surface that benefits from real estate.
    const onToggleExpanded = vi.fn();
    await using _ = await mountRail({
      onToggleExpanded,
      focusedPath: "/Users/jlm/some/file.md",
    });

    // Viewer overlay is open — find its expand button.
    await page.getByLabelText("Expand viewer").click();
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("rail header has no expand button (drag handles widening; expand is viewer-only)", async () => {
    await using _ = await mountRail();
    // No expand affordance anywhere on the rail when the viewer isn't open.
    expect(document.querySelector('[aria-label^="Expand "]')).toBeNull();
    expect(document.querySelector('[aria-label^="Shrink "]')).toBeNull();
  });

  it("closing the viewer also collapses the rail (so the chat column reappears)", async () => {
    const onToggleExpanded = vi.fn();
    await using _ = await mountRail({
      onToggleExpanded,
      focusedPath: "/Users/jlm/some/file.md",
      expanded: true,
    });
    await vi.waitFor(() => {
      expect(viewerOverlayCount()).toBe(1);
    });
    // The viewer's X = close viewer. Because we were expanded, this should
    // also fire onToggleExpanded so the parent shrinks the rail back.
    await page.getByLabelText("Close viewer pane").click();
    await vi.waitFor(() => {
      expect(onToggleExpanded).toHaveBeenCalledTimes(1);
    });
  });

  it("Collapse button (panel icon in rail header) calls onClose", async () => {
    // The rail-header button is the "collapse the whole panel back" affordance
    // (panel icon, not X) — semantically distinct from each card's local X.
    const onClose = vi.fn();
    await using _ = await mountRail({ onClose });
    await page.getByLabelText("Collapse console panel").click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("auto-shows the Tasks card when a plan first becomes available", async () => {
    await using _ = await mountRail({
      activeProposedPlan: {
        id: OrchestrationProposedPlanId.make("plan-test-1"),
        createdAt: "2026-04-18T12:00:00Z",
        updatedAt: "2026-04-18T12:00:00Z",
        turnId: MakeTurnId.make("turn-1"),
        planMarkdown: "# Test plan\n\nDo the thing.",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
    await vi.waitFor(() => {
      expect(visiblePaneIds()).toContain("task");
    });
  });

  it("focusedPath prop opens the viewer takeover overlay", async () => {
    await using _ = await mountRail({
      focusedPath: "/Users/jlm/some/file.md",
    });
    await vi.waitFor(() => {
      expect(viewerOverlayCount()).toBe(1);
    });
  });

  it("closing the viewer overlay restores the stack underneath", async () => {
    await using _ = await mountRail({
      focusedPath: "/Users/jlm/some/file.md",
    });
    await vi.waitFor(() => {
      expect(viewerOverlayCount()).toBe(1);
    });
    await page.getByLabelText("Close viewer pane").click();
    await vi.waitFor(() => {
      expect(viewerOverlayCount()).toBe(0);
      // Stack body still rendered with its cards.
      expect(visiblePaneIds()).toContain("tree");
    });
  });
});

// ----- viewer (Phase 2: doc-tuned markdown + inline edit) -----

describe("ConsoleRail viewer (Phase 2)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.localStorage.clear();
    environmentApiStub = null;
    mockReadFileResponse = null;
    vi.clearAllMocks();
  });

  it("uses the doc-tuned markdown wrapper for .md previews (not the chat-tuned one)", async () => {
    mockReadFileResponse = {
      contents: "# Hello\n\nDocument content.",
      relativePath: "some/file.md",
      truncated: false,
    };
    await using _ = await mountRail({
      workspaceRoot: "/Users/jlm/proj",
      focusedPath: "/Users/jlm/proj/some/file.md",
    });
    await vi.waitFor(() => {
      // The DocumentMarkdown wrapper applies the .document-markdown class so
      // the typography overrides in index.css can target it.
      expect(document.querySelector(".document-markdown")).not.toBeNull();
    });
  });

  it("shows a Quick edit button for editable categories (markdown notes)", async () => {
    await using _ = await mountRail({
      focusedPath: "/Users/jlm/some/file.md",
    });
    await vi.waitFor(() => {
      expect(document.querySelector('button[title="Quick edit this file inline"]')).not.toBeNull();
    });
  });

  it("clicking Quick edit reveals the textarea + Save and Cancel buttons", async () => {
    mockReadFileResponse = {
      contents: "# Original\n\nBefore the edit.",
      relativePath: "some/file.md",
      truncated: false,
    };
    await using _ = await mountRail({
      workspaceRoot: "/Users/jlm/proj",
      focusedPath: "/Users/jlm/proj/some/file.md",
    });
    await page.getByTitle("Quick edit this file inline").click();
    await vi.waitFor(() => {
      expect(page.getByLabelText("Edit file contents")).toBeDefined();
      expect(document.body.textContent ?? "").toContain("Save");
      expect(document.body.textContent ?? "").toContain("Cancel");
    });
  });

  it("Save is disabled until the user actually changes the buffer", async () => {
    mockReadFileResponse = {
      contents: "# Original\n\nBefore the edit.",
      relativePath: "some/file.md",
      truncated: false,
    };
    await using _ = await mountRail({
      workspaceRoot: "/Users/jlm/proj",
      focusedPath: "/Users/jlm/proj/some/file.md",
    });
    await page.getByTitle("Quick edit this file inline").click();
    await vi.waitFor(() => {
      const saveBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => (b.textContent ?? "").trim() === "Save",
      );
      expect(saveBtn).toBeDefined();
      expect(saveBtn!.disabled).toBe(true);
    });
  });

  it("Save calls projects.writeFile with the relative path + edited contents", async () => {
    mockReadFileResponse = {
      contents: "# Original\n\nBefore the edit.",
      relativePath: "some/file.md",
      truncated: false,
    };
    const writeFile = vi
      .fn<
        (input: {
          cwd: string;
          relativePath: string;
          contents: string;
        }) => Promise<{ relativePath: string }>
      >()
      .mockResolvedValue({ relativePath: "some/file.md" });
    environmentApiStub = { projects: { writeFile } };

    await using _ = await mountRail({
      workspaceRoot: "/Users/jlm/proj",
      focusedPath: "/Users/jlm/proj/some/file.md",
    });

    await page.getByTitle("Quick edit this file inline").click();

    // Use Vitest browser's React-aware fill so the controlled textarea picks
    // up the new value through its onChange.
    await page.getByLabelText("Edit file contents").fill("# Fresh\n\nWritten inline.");

    const saveBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => (b.textContent ?? "").trim() === "Save",
    )!;
    await vi.waitFor(() => {
      expect(saveBtn.disabled).toBe(false);
    });
    saveBtn.click();

    await vi.waitFor(() => {
      expect(writeFile).toHaveBeenCalledTimes(1);
      expect(writeFile.mock.calls[0]![0]).toEqual({
        cwd: "/Users/jlm/proj",
        relativePath: "some/file.md",
        contents: "# Fresh\n\nWritten inline.",
      });
    });
  });

  it("Cancel exits edit mode without writing", async () => {
    const writeFile = vi.fn();
    environmentApiStub = { projects: { writeFile } };

    await using _ = await mountRail({
      workspaceRoot: "/Users/jlm/proj",
      focusedPath: "/Users/jlm/proj/some/file.md",
    });
    await page.getByTitle("Quick edit this file inline").click();
    await vi.waitFor(() => {
      expect(document.querySelector('textarea[aria-label="Edit file contents"]')).not.toBeNull();
    });

    const cancelBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => (b.textContent ?? "").trim() === "Cancel",
    )!;
    cancelBtn.click();

    await vi.waitFor(() => {
      expect(document.querySelector('textarea[aria-label="Edit file contents"]')).toBeNull();
      expect(writeFile).not.toHaveBeenCalled();
    });
  });

  it("Source switches the viewer to raw file contents", async () => {
    mockReadFileResponse = {
      contents: "# Hello\n\nDocument content.",
      relativePath: "some/file.md",
      truncated: false,
    };
    await using _ = await mountRail({
      workspaceRoot: "/Users/jlm/proj",
      focusedPath: "/Users/jlm/proj/some/file.md",
    });

    await page.getByTitle("View raw source").click();

    await vi.waitFor(() => {
      expect(document.querySelector(".document-markdown")).toBeNull();
      expect(document.body.textContent ?? "").toContain("# Hello");
      expect(document.body.textContent ?? "").toContain("Document content.");
    });
  });
});

// ----- visual snapshots -----

describe("ConsoleRail (visual snapshots)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.localStorage.clear();
    environmentApiStub = null;
    mockReadFileResponse = null;
    vi.clearAllMocks();
  });

  it("snapshot — default stack (Files, Recent edited files, Tasks)", async () => {
    await using _ = await mountRail();
    await vi.waitFor(() => {
      expect(visiblePaneIds()).toEqual(["tree", "recent", "task"]);
    });
    await page.screenshot({ path: "__screenshots__/stack-default.png" });
  });

  it("snapshot — stack with Files + Recent edited files + Tasks all visible", async () => {
    window.localStorage.setItem(
      VISIBILITY_KEY,
      JSON.stringify({ tree: true, recent: true, task: true }),
    );
    await using _ = await mountRail();
    await vi.waitFor(() => {
      expect(visiblePaneIds()).toEqual(["tree", "recent", "task"]);
    });
    await page.screenshot({ path: "__screenshots__/stack-all-cards.png" });
  });

  it("snapshot — Files collapsed (header only), Tasks expanded", async () => {
    window.localStorage.setItem(
      VISIBILITY_KEY,
      JSON.stringify({ tree: true, recent: false, task: true }),
    );
    window.localStorage.setItem(
      COLLAPSED_KEY,
      JSON.stringify({ tree: true, recent: false, task: false }),
    );
    await using _ = await mountRail();
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-pane-id="tree"][data-pane-collapsed="true"]'),
      ).not.toBeNull();
    });
    await page.screenshot({ path: "__screenshots__/stack-collapsed-files.png" });
  });

  it("snapshot — viewer takeover overlay (covers the stack)", async () => {
    await using _ = await mountRail({
      focusedPath: "/Users/jlm/some/file.md",
    });
    await vi.waitFor(() => {
      expect(viewerOverlayCount()).toBe(1);
    });
    await page.screenshot({ path: "__screenshots__/viewer-takeover.png" });
  });

  it("snapshot — Console badge menu open with checkbox entries", async () => {
    await using _ = await mountRail();
    await page.getByLabelText("Add or remove console panes").click();
    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Tasks");
    });
    await page.screenshot({ path: "__screenshots__/console-menu-open.png" });
  });
});
