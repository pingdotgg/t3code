import type { EditorId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { editorIconOptions } from "./components/editorIcons";
import { useTheme } from "./hooks/useTheme";

const ICON_PIXELS = 32;
const SVG_NS = "http://www.w3.org/2000/svg";
const NO_ICONS: ReadonlyMap<EditorId, string> = new Map();

// Logos are styled by Tailwind and the theme, so render them in the document and inline the
// computed paint before rasterizing; native menus only accept bitmaps.
async function rasterizeEditorIcon(editor: EditorId): Promise<string | null> {
  const option = editorIconOptions(navigator.platform).find(({ value }) => value === editor);
  if (option === undefined) return null;
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:16px;height:16px;";
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <option.Icon
          className={
            option.kind === "brand" ? "size-4 text-foreground" : "size-4 text-muted-foreground"
          }
        />,
      ),
    );
    const svg = host.querySelector("svg");
    if (svg === null) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const sources = [svg, ...svg.querySelectorAll("*")];
    const targets = [clone, ...clone.querySelectorAll("*")];
    sources.forEach((source, index) => {
      const computed = getComputedStyle(source);
      const target = targets[index];
      target?.setAttribute(
        "style",
        `${target.getAttribute("style") ?? ""};fill:${computed.fill};stroke:${computed.stroke}`,
      );
    });
    clone.removeAttribute("class");
    clone.setAttribute("xmlns", SVG_NS);
    clone.setAttribute("width", String(ICON_PIXELS));
    clone.setAttribute("height", String(ICON_PIXELS));
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = ICON_PIXELS;
    canvas.height = ICON_PIXELS;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(image, 0, 0, ICON_PIXELS, ICON_PIXELS);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  } finally {
    root.unmount();
    host.remove();
  }
}

// Keyed by theme and editor list; both change rarely, and each key rasterizes once.
const editorMenuIconsAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyMap<EditorId, string> => {
    const editors = key
      .slice(key.indexOf("|") + 1)
      .split(",")
      .filter(Boolean) as EditorId[];
    // Render outside the reading component's render pass.
    void Promise.resolve().then(async () => {
      const icons = new Map<EditorId, string>();
      for (const editor of editors) {
        const icon = await rasterizeEditorIcon(editor);
        if (icon !== null) icons.set(editor, icon);
      }
      if (icons.size > 0) get.setSelf(icons);
    });
    return NO_ICONS;
  }).pipe(Atom.keepAlive, Atom.withLabel(`editor-menu-icons:${key}`)),
);

/** PNG data URLs of editor logos for context menus; empty until rendered. */
export function useEditorMenuIcons(
  editors: ReadonlyArray<EditorId>,
): ReadonlyMap<EditorId, string> {
  const { resolvedTheme } = useTheme();
  return useAtomValue(editorMenuIconsAtom(`${resolvedTheme}|${editors.join(",")}`));
}
