import { useEffect } from "react";
import { observeCopyOnHighlight } from "~/lib/copyOnHighlight";
import { useClientSettings } from "./useSettings";
import { writeTextToClipboard } from "./useCopyToClipboard";

export function useCopyOnHighlight(viewport: HTMLElement | null) {
  const enabled = useClientSettings().copyOnHighlight;
  useEffect(() => {
    if (!enabled || !viewport) return;
    return observeCopyOnHighlight(viewport, (text) => writeTextToClipboard(text, "selection"));
  }, [enabled, viewport]);
}
