import { parseDiffFromFile } from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useDiffReviewKeyboard } from "./useDiffReviewKeyboard";

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

function Panel(props: { folds: string[]; clicks: string[] }) {
  const { rootRef } = useDiffReviewKeyboard({
    scopeKey: "scope",
    files: [file],
    diffStyle: "unified",
    canLoadFullFiles: false,
    autoAdvanceOnViewed: false,
    getViewer: () => null,
    isCollapsed: () => false,
    setCollapsed: (fileKey) => void props.folds.push(fileKey),
    isViewed: () => false,
    setViewed: () => {},
    revealFile: () => {},
    beginComment: () => {},
  });
  return (
    <div ref={rootRef} tabIndex={-1} data-diff-panel data-testid="panel">
      <button type="button" onClick={() => props.clicks.push("Changes")}>
        Changes
      </button>
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
  await userEvent.keyboard("{Enter} ");

  expect(folds).toEqual(["a", "a"]);
  expect(clicks).toEqual(["Changes", "Changes"]);
});

it("leaves Enter and Space to a control reached with Tab", async () => {
  const folds: string[] = [];
  const clicks: string[] = [];
  await using screen = await render(<Panel folds={folds} clicks={clicks} />, options);
  screen.getByTestId("panel").element().focus();
  await userEvent.keyboard("j");

  await userEvent.keyboard("{Tab}{Enter} ");

  expect(folds).toEqual([]);
  expect(clicks).toEqual(["Changes", "Changes"]);
});
