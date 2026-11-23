import { HTML_RENDER_ELEMENT_FULLSCREEN_SCRIPT } from "@t3tools/shared/htmlRender";
import type { WebContents } from "electron";

/**
 * Has every page framed in the window report which of its elements is fullscreen. The script runs
 * from here and not from the page's own markup because a published page is served as it was saved.
 */
export const reportFramedElementFullscreen = (contents: WebContents) => {
  contents.on("frame-created", (_event, { frame }) => {
    if (frame === null || frame.parent === null) return;
    frame.on("dom-ready", () => {
      void frame.executeJavaScript(HTML_RENDER_ELEMENT_FULLSCREEN_SCRIPT).catch(() => undefined);
    });
  });
};
