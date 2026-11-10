import { parseDiffFromFile } from "@pierre/diffs";
// oxlint-disable-next-line eslint/no-restricted-imports -- exercises hydration in the patched dependency without app theme services
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import {
  DiffReviewCursorContext,
  useDiffReviewCursorFilePath,
  useDiffReviewKeyboard,
  useDiffReviewSelectedLines,
} from "./useDiffReviewKeyboard";

vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return { primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS) };
});

const file = {
  fileKey: "a",
  filePath: "a.ts",
  fileDiff: parseDiffFromFile({ name: "a.ts", contents: "a\n" }, { name: "a.ts", contents: "b\n" }),
  rendered: true,
};
const otherFile = { ...file, fileKey: "b", filePath: "b.ts" };

function CursorFile() {
  const filePath = useDiffReviewCursorFilePath();
  const onLines = useDiffReviewSelectedLines() !== null;
  return filePath === null ? null : <p>Cursor on {onLines ? `lines of ${filePath}` : filePath}</p>;
}

function Panel(props: {
  folds: string[];
  clicks: string[];
  reveals?: string[];
  renders?: string[];
  hidden?: boolean;
  twoFiles?: boolean;
  viewedUnsupported?: boolean;
  autoAdvance?: boolean;
}) {
  props.renders?.push("panel");
  const { rootRef, cursorStore, singleFile, toggleFileCollapsed } = useDiffReviewKeyboard({
    scopeKey: "scope",
    files: props.twoFiles ? [file, otherFile] : [file],
    diffStyle: "unified",
    canLoadFullFiles: false,
    autoAdvanceOnViewed: props.autoAdvance ?? false,
    getViewer: () => null,
    isCollapsed: () => false,
    setCollapsed: (fileKey) => void props.folds.push(fileKey),
    isViewed: () => false,
    setViewed: props.viewedUnsupported ? null : () => {},
    revealFile: (revealed) => void props.reveals?.push(revealed.fileKey),
    beginComment: () => {},
  });
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-diff-panel
      data-testid="panel"
      style={props.hidden ? { visibility: "hidden" } : undefined}
    >
      <button type="button" onClick={() => props.clicks.push("Changes")}>
        Changes
      </button>
      <button type="button" onClick={() => toggleFileCollapsed("a")}>
        Collapse a.ts
      </button>
      {singleFile ? <p>One file at a time</p> : null}
      <DiffReviewCursorContext value={cursorStore}>
        <CursorFile />
      </DiffReviewCursorContext>
    </div>
  );
}

// router: false because the panel stand-in never navigates.
const options = { router: false } as const;

it("takes the keys from a clicked control and drops its focus ring", async () => {
  const folds: string[] = [];
  const clicks: string[] = [];
  await using screen = await render(<Panel folds={folds} clicks={clicks} />, options);
  await userEvent.click(screen.getByRole("button", { name: "Changes" }));

  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(screen.getByTestId("panel").element());
  await userEvent.click(screen.getByRole("button", { name: "Changes" }));
  await userEvent.keyboard("{Enter}");

  expect(folds).toEqual(["a"]);
  expect(clicks).toEqual(["Changes", "Changes"]);
});

it("leaves v alone where files cannot be marked viewed", async () => {
  const folds: string[] = [];
  await using screen = await render(
    <Panel folds={folds} clicks={[]} viewedUnsupported autoAdvance twoFiles />,
    options,
  );
  screen.getByTestId("panel").element().focus();

  await userEvent.keyboard("jv");

  expect(folds).toEqual([]);
  await expect.element(screen.getByText("Cursor on a.ts")).toBeInTheDocument();
});

it("leaves Enter to a control reached with Tab", async () => {
  const folds: string[] = [];
  const clicks: string[] = [];
  await using screen = await render(<Panel folds={folds} clicks={clicks} />, options);
  screen.getByTestId("panel").element().focus();
  await userEvent.keyboard("j");

  await userEvent.keyboard("{Tab}{Enter}");

  expect(folds).toEqual([]);
  expect(clicks).toEqual(["Changes"]);
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(screen.getByTestId("panel").element());
});

it("takes the keys from anywhere in the panel showing the diff", async () => {
  const reveals: string[] = [];
  const hiddenReveals: string[] = [];
  await using screen = await render(
    <>
      <div data-workspace-area="panel">
        <button type="button">Code</button>
        <Panel folds={[]} clicks={[]} reveals={reveals} />
        <Panel folds={[]} clicks={[]} reveals={hiddenReveals} hidden />
      </div>
      <button type="button">Elsewhere</button>
    </>,
    options,
  );

  await userEvent.click(screen.getByRole("button", { name: "Code" }));
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(screen.getByTestId("panel").first().element());
  await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
  await userEvent.keyboard("j");

  expect(reveals).toEqual(["a"]);
  expect(hiddenReveals).toEqual([]);
});

it("moves the cursor without redrawing the panel", async () => {
  const renders: string[] = [];
  await using screen = await render(<Panel folds={[]} clicks={[]} renders={renders} />, options);
  screen.getByTestId("panel").element().focus();
  const rendersBefore = renders.length;

  await userEvent.keyboard("j");

  await expect.element(screen.getByText("Cursor on a.ts")).toBeInTheDocument();
  expect(renders).toHaveLength(rendersBefore);
});

it("returns to the full list when the single shown file is closed", async () => {
  const folds: string[] = [];
  await using screen = await render(<Panel folds={folds} clicks={[]} />, options);
  screen.getByTestId("panel").element().focus();
  await userEvent.keyboard("f");
  await expect.element(screen.getByText("One file at a time")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Collapse a.ts" }));

  await expect.element(screen.getByText("One file at a time")).not.toBeInTheDocument();
  expect(folds).toEqual(["a"]);
});

it("leaves a file's lines past either end", async () => {
  const folds: string[] = [];
  await using screen = await render(<Panel folds={folds} clicks={[]} twoFiles />, options);
  screen.getByTestId("panel").element().focus();
  await userEvent.keyboard("ji");
  await expect.element(screen.getByText("Cursor on lines of a.ts")).toBeInTheDocument();

  await userEvent.keyboard("k");
  await expect.element(screen.getByText("Cursor on a.ts")).toBeInTheDocument();

  await userEvent.keyboard("ijj");
  const foldsBefore = [...folds];
  await userEvent.keyboard("j");
  await expect.element(screen.getByText("Cursor on b.ts")).toBeInTheDocument();
  expect(folds).toEqual(foldsBefore);
});

it("expands unchanged context after an equivalent partial diff refreshes", async () => {
  const patch = "--- a/review.txt\n+++ b/review.txt\n@@ -48 +48 @@\n-context 48\n+changed 48\n";
  const before = Array.from({ length: 80 }, (_, index) => `context ${index + 1}\n`).join("");
  const viewer = { current: null as CodeViewHandle<unknown, undefined> | null };
  const options = {
    diffStyle: "unified" as const,
    loadDiffFiles: async () => ({
      oldFile: { name: "review.txt", contents: before },
      newFile: { name: "review.txt", contents: before.replace("context 48", "changed 48") },
    }),
  };
  const items = (version: number) => [
    {
      id: "review",
      type: "diff" as const,
      version,
      fileDiff: parsePatchFiles(patch, { cacheKeyPrefix: "refresh" })[0]!.files[0]!,
    },
  ];
  await using screen = await render(<CodeView ref={viewer} items={items(1)} options={options} />);
  await vi.waitFor(() => expect(viewer.current?.getInstance()?.getRenderedItems()).toHaveLength(1));
  await screen.rerender(<CodeView ref={viewer} items={items(2)} options={options} />);
  const rendered = viewer.current!.getInstance()!.getRenderedItems()[0]!;
  if (rendered.type !== "diff") throw new Error("Expected a diff");
  await act(() => rendered.instance.expandHunk(0, "down", 20));
  await expect.element(screen.getByText("context 47", { exact: true })).toBeVisible();
});
