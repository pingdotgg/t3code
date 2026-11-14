import { CodeView, DEFAULT_THEMES, parsePatchFiles, preloadHighlighter } from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";

const OLD_LINES = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
const NEW_LINES = OLD_LINES.with(0, "changed 1").with(59, "changed 60");
const PATCH = `diff --git a/notes.txt b/notes.txt
--- a/notes.txt
+++ b/notes.txt
@@ -1,4 +1,4 @@
-line 1
+changed 1
 line 2
 line 3
 line 4
@@ -57,4 +57,4 @@
 line 57
 line 58
 line 59
-line 60
+changed 60
`;

function parsePartialDiff() {
  return parsePatchFiles(PATCH, { cacheKeyPrefix: "notes" })[0]!.files[0]!;
}

// A diff refresh re-parses an unchanged patch into a new object with the same cacheKey.
// Upstream keeps rendering the old object and then discards the file contents loaded for it.
it("expands hidden context after the host re-supplies an unchanged partial diff", async () => {
  await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["text"] });
  const root = document.createElement("div");
  root.style.cssText = "width: 800px; height: 600px; overflow: auto;";
  document.body.append(root);
  const view = new CodeView<undefined>({
    diffStyle: "unified",
    loadDiffFiles: async () => ({
      oldFile: { name: "notes.txt", contents: `${OLD_LINES.join("\n")}\n` },
      newFile: { name: "notes.txt", contents: `${NEW_LINES.join("\n")}\n` },
    }),
  });
  using _view = {
    [Symbol.dispose]: () => {
      view.cleanUp();
      root.remove();
    },
  };
  view.setup(root);
  const shadowRoot = () => root.querySelector("diffs-container")?.shadowRoot;
  const lines = () =>
    Array.from(shadowRoot()?.querySelectorAll("[data-line]") ?? [], (line) => line.textContent);

  view.setItems([{ id: "notes", type: "diff", fileDiff: parsePartialDiff(), version: 1 }]);
  await vi.waitFor(() => expect(lines()).toContain("line 57"));
  view.setItems([{ id: "notes", type: "diff", fileDiff: parsePartialDiff(), version: 2 }]);

  shadowRoot()!.querySelector<HTMLElement>("[data-expand-button]")!.click();

  await vi.waitFor(() => expect(lines()).toContain("line 30"));
});
