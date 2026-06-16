import "../../index.css";

import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "~/composerDraftStore";

import { AnnotatableFileDiff } from "./AnnotatableFileDiff";

function dispatchPointer(target: EventTarget, type: string, pointerId: number): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId,
      pointerType: "mouse",
    }),
  );
}

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread-1"));

function TestDiff() {
  const fileDiff = parsePatchFiles(
    [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
    ].join("\n"),
    "annotatable-file-diff-test",
  )[0]!.files[0]!;

  return (
    <AnnotatableFileDiff
      fileDiff={fileDiff}
      filePath="src/app.ts"
      sectionId="turn:2"
      sectionTitle="Turn 2"
      composerDraftTarget={threadRef}
      renderHeaderPrefix={() => null}
      options={{
        diffStyle: "unified",
        lineDiffType: "none",
        themeType: "light",
      }}
    />
  );
}

async function getRenderedDiff() {
  return vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>("diffs-container");
    expect(element?.shadowRoot).not.toBeNull();
    return element!;
  });
}

describe("annotatable Pierre file diff", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.getState().setReviewComments(threadRef, []);
  });

  it("creates a local annotation from the gutter and attaches it to the composer", async () => {
    let screen = await render(<TestDiff />);

    try {
      const diff = await getRenderedDiff();
      const addedLineNumber = await vi.waitFor(() => {
        const elements = Array.from(
          diff.shadowRoot?.querySelectorAll<HTMLElement>('[data-column-number="2"]') ?? [],
        );
        const element = elements.at(-1) ?? null;
        expect(element).not.toBeNull();
        return element!;
      });

      dispatchPointer(addedLineNumber, "pointerdown", 1);
      dispatchPointer(addedLineNumber, "pointerup", 1);

      const textarea = page.getByRole("textbox", { name: "Comment on lines +2" });
      await expect.element(textarea).toBeVisible();
      await textarea.fill("Use the compatible value.");
      await page.getByRole("button", { name: "Comment" }).click();

      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().getComposerDraft(threadRef)?.reviewComments,
        ).toEqual([
          expect.objectContaining({
            sectionId: "turn:2",
            filePath: "src/app.ts",
            rangeLabel: "+2",
            text: "Use the compatible value.",
            diff: "@@ -0,0 +2,1 @@\n+TWO",
          }),
        ]);
      });
      expect(document.querySelector("[data-file-comment-annotation]")?.textContent).toContain(
        "Use the compatible value.",
      );

      await screen.unmount();
      screen = await render(<TestDiff />);
      await expect
        .element(page.getByText("Use the compatible value.", { exact: true }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
