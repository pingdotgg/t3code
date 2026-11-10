import type * as Electron from "electron";

/** Names the renderer gives iframes it searches, so a page cannot opt the app shell in. */
export const FIND_FRAME_NAME_PREFIX = "t3-file-find-";

export const isFindShortcut = (input: Electron.Input, platform: NodeJS.Platform): boolean =>
  input.type === "keyDown" &&
  (platform === "darwin" ? input.meta : input.control) &&
  !input.alt &&
  !input.shift &&
  input.key.toLowerCase() === "f";

// Runs inside the opaque-origin frame, which the renderer cannot reach; an empty query clears it.
export const frameFindScript = (query: string, index: number): string =>
  `(() => {
  const H = typeof CSS !== "undefined" && CSS.highlights;
  if (!H || typeof Highlight === "undefined") return 0;
  H.delete("t3-file-find");
  H.delete("t3-file-find-active");
  const q = ${JSON.stringify(query.toLowerCase())};
  if (q.length === 0) return 0;
  if (!document.getElementById("t3-file-find-style")) {
    const style = document.createElement("style");
    style.id = "t3-file-find-style";
    style.textContent = "::highlight(t3-file-find){background:oklch(0.915 0.11 85);color:oklch(0.216 0.028 77.4)}::highlight(t3-file-find-active){background:oklch(0.8 0.16 70);color:oklch(0.216 0.028 77.4)}";
    (document.head || document.documentElement).append(style);
  }
  const ranges = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.data.toLowerCase();
    for (let at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + q.length)) {
      const range = new Range();
      range.setStart(node, at);
      range.setEnd(node, at + q.length);
      ranges.push(range);
    }
  }
  if (ranges.length === 0) return 0;
  const active = ranges[Math.min(${Math.max(0, Math.trunc(index))}, ranges.length - 1)];
  H.set("t3-file-find", new Highlight(...ranges.filter((range) => range !== active)));
  H.set("t3-file-find-active", new Highlight(active));
  active.startContainer.parentElement?.scrollIntoView({ block: "nearest" });
  return ranges.length;
})()`;

export const findFrameByName = (
  contents: Electron.WebContents,
  frameName: string,
): Electron.WebFrameMain | undefined => {
  if (!frameName.startsWith(FIND_FRAME_NAME_PREFIX)) return undefined;
  const main = contents.mainFrame;
  return main.framesInSubtree.find((frame) => frame !== main && frame.name === frameName);
};
