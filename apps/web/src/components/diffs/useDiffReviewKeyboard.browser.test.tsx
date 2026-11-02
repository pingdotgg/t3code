import { parseDiffFromFile } from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
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
}) {
  props.renders?.push("panel");
  const { rootRef, cursorStore, singleFile, toggleFileCollapsed } = useDiffReviewKeyboard({
    scopeKey: "scope",
    files: props.twoFiles ? [file, otherFile] : [file],
    diffStyle: "unified",
    canLoadFullFiles: false,
    autoAdvanceOnViewed: false,
    getViewer: () => null,
    isCollapsed: () => false,
    setCollapsed: (fileKey) => void props.folds.push(fileKey),
    isViewed: () => false,
    setViewed: () => {},
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
