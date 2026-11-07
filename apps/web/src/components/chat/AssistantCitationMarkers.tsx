import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import { draftCitationMarkers } from "./assistantCitationMarkers.logic";
import { useLayoutEffect, useRef } from "react";
import { observeResize } from "~/lib/observeResize";
import { buildDocJson } from "~/composer-rich-text-doc";
import {
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";

export function AssistantCitationMarkers({
  viewport,
  prompt,
  onOpen,
}: {
  viewport: HTMLElement | null;
  prompt: string;
  onOpen: (index: number, anchor: AssistantCitationSourceAnchor) => void;
}) {
  const citations = draftCitationMarkers(buildDocJson(prompt, () => null));
  const overlayRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions markers against rendered source ranges as the timeline scrolls and virtualizes rows
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!viewport || !overlay || citations.length === 0) return;
    const update = () => {
      const bounds = viewport.getBoundingClientRect();
      for (const [index, { citation }] of citations.entries()) {
        const button = overlay.children[index] as HTMLButtonElement;
        const anchor = findAssistantCitationSourceAnchor(viewport.ownerDocument, citation);
        const rect =
          anchor && viewport.contains(anchor.source)
            ? Array.from(anchor.range.getClientRects()).findLast(
                (rect) => rect.width > 0 && rect.height > 0,
              )
            : null;
        const visible = rect && rect.bottom > bounds.top && rect.top < bounds.bottom;
        button.hidden = !visible;
        if (rect && visible) {
          button.style.left = `${Math.min(bounds.width - 22, Math.max(0, rect.right - bounds.left + 3))}px`;
          button.style.top = `${rect.bottom - bounds.top - 18}px`;
        }
      }
    };
    const stopResize = observeResize(viewport, update);
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !overlay.contains(record.target))) update();
    });
    mutations.observe(viewport, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    viewport.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    update();
    return () => {
      stopResize();
      mutations.disconnect();
      viewport.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [viewport, citations]);
  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
      aria-label="Draft citation markers"
    >
      {citations.map(({ citation, key }, index) => (
        <button
          key={key}
          type="button"
          hidden={!viewport}
          className="pointer-events-auto absolute flex size-5 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground"
          aria-label={`Edit citation ${index + 1} comment`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            if (!viewport) return;
            const anchor = findAssistantCitationSourceAnchor(viewport.ownerDocument, citation);
            if (!anchor || !viewport.contains(anchor.source)) return;
            const selection = viewport.ownerDocument.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(anchor.range);
            onOpen(index, anchor);
          }}
        >
          {index + 1}
        </button>
      ))}
    </div>
  );
}

export function ActiveDraftCitationMarkers({
  draftTarget,
  ...props
}: Omit<Parameters<typeof AssistantCitationMarkers>[0], "prompt"> & {
  draftTarget: ComposerThreadTarget;
}) {
  const prompt = useComposerDraftStore(
    (store) => store.getComposerDraft(draftTarget)?.prompt ?? "",
  );
  return <AssistantCitationMarkers {...props} prompt={prompt} />;
}
