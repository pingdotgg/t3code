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
  onOpen: (key: string, anchor: AssistantCitationSourceAnchor) => void;
}) {
  const citationJson = JSON.stringify(draftCitationMarkers(buildDocJson(prompt, () => null)));
  const citations = JSON.parse(citationJson) as ReturnType<typeof draftCitationMarkers>;
  const overlayRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions markers against rendered source ranges as the timeline scrolls and virtualizes rows
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!viewport || !overlay || citations.length === 0) return;
    let frame: number | null = null;
    const anchors = new Map<string, AssistantCitationSourceAnchor | null>();
    const update = () => {
      frame = null;
      const bounds = viewport.getBoundingClientRect();
      const positions: { left: number; top: number }[] = [];
      for (const [index, { citation, key }] of citations.entries()) {
        const button = overlay.children[index] as HTMLButtonElement;
        if (!anchors.has(key)) {
          const anchor = findAssistantCitationSourceAnchor(viewport, citation);
          anchors.set(key, anchor);
          if (anchor)
            sourceMutations.observe(anchor.source, { subtree: true, characterData: true });
        }
        const anchor = anchors.get(key);
        const rect =
          anchor &&
          Array.from(anchor.range.getClientRects()).findLast(
            (rect) =>
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > bounds.top &&
              rect.top < bounds.bottom &&
              rect.right > bounds.left &&
              rect.left < bounds.right,
          );
        button.hidden = !rect;
        if (rect) {
          let left = Math.min(
            Math.max(0, bounds.width - 20),
            Math.max(0, rect.right - bounds.left + 3),
          );
          let top = Math.min(
            Math.max(0, bounds.height - 20),
            Math.max(0, rect.bottom - bounds.top - 18),
          );
          const overlaps = (x: number, y: number) =>
            positions.some(
              (position) => Math.abs(position.left - x) < 22 && Math.abs(position.top - y) < 22,
            );
          if (overlaps(left, top)) {
            let distance = Infinity;
            let position: { left: number; top: number } | undefined;
            for (let y = Math.max(0, bounds.height - 20); y >= 0; y -= 22) {
              for (let x = Math.max(0, bounds.width - 20); x >= 0; x -= 22) {
                const candidateDistance = Math.abs(x - left) + Math.abs(y - top);
                if (!overlaps(x, y) && candidateDistance < distance) {
                  distance = candidateDistance;
                  position = { left: x, top: y };
                }
              }
            }
            if (position) {
              left = position.left;
              top = position.top;
            }
          }
          positions.push({ left, top });
          button.style.left = `${left}px`;
          button.style.top = `${top}px`;
        }
      }
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    const stopResize = observeResize(viewport, schedule);
    const mutations = new MutationObserver((records) => {
      const relevant = records.filter((record) => !overlay.contains(record.target));
      if (relevant.length === 0) return;
      for (const [key, anchor] of anchors) {
        if (
          !anchor ||
          !viewport.contains(anchor.source) ||
          relevant.some((record) => anchor.source.contains(record.target))
        )
          anchors.delete(key);
      }
      schedule();
    });
    mutations.observe(viewport, { childList: true, subtree: true });
    const sourceMutations = new MutationObserver((records) => {
      for (const [key, anchor] of anchors) {
        if (anchor && records.some((record) => anchor.source.contains(record.target)))
          anchors.delete(key);
      }
      schedule();
    });
    for (const { citation, key } of citations) {
      const anchor = findAssistantCitationSourceAnchor(viewport, citation);
      anchors.set(key, anchor);
      if (anchor) sourceMutations.observe(anchor.source, { subtree: true, characterData: true });
    }
    viewport.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      stopResize();
      sourceMutations.disconnect();
      mutations.disconnect();
      viewport.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
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
          data-citation-marker-key={key}
          type="button"
          hidden={!viewport}
          className="pointer-events-auto absolute flex size-5 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground"
          aria-label={`Edit citation ${index + 1} comment`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            if (!viewport) return;
            const anchor = findAssistantCitationSourceAnchor(viewport, citation);
            if (!anchor || !viewport.contains(anchor.source)) return;
            const selection = viewport.ownerDocument.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(anchor.range);
            onOpen(key, anchor);
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
