import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";

describe("alert dialog description", () => {
  it("keeps a long payload in a bounded scroll region so the actions stay put", () => {
    const payload = `{elements:[${"x".repeat(4_000)}]}`;
    const markup = renderToStaticMarkup(
      <AlertDialog>
        <AlertDialogHeader>
          <AlertDialogTitle>Allow excalidraw to run export_to_excalidraw?</AlertDialogTitle>
          <AlertDialogDescription>{payload}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>Cancel</AlertDialogFooter>
      </AlertDialog>,
    );
    const header = /<div[^>]*data-slot="alert-dialog-header"[^>]*>/.exec(markup)?.[0] ?? "";
    const description = /<p[^>]*data-slot="alert-dialog-description"[^>]*>/.exec(markup)?.[0] ?? "";

    // The whole payload stays available to inspect, untruncated…
    expect(markup).toContain(payload);
    // …but bounded: the header may shrink inside the height-capped popup and
    // the description scrolls instead of pushing the footer off screen.
    expect(header).toContain("min-h-0");
    expect(description).toContain("max-h-[min(24rem,60dvh)]");
    expect(description).toContain("overflow-y-auto");
    expect(description).toContain("overscroll-contain");
    expect(description).toContain("wrap-anywhere");
    expect(markup.indexOf("</p>")).toBeLessThan(markup.indexOf("Cancel"));
  });
});
