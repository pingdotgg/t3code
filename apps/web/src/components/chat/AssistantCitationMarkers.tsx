import { Badge } from "~/components/ui/badge";
import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import { draftCitationMarkers } from "./assistantCitationMarkers.logic";
import { useLayoutEffect, useRef } from "react";
import { observeResize } from "~/lib/observeResize";
import { buildDocJson } from "~/composer-rich-text-doc";
import {
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";

export function updateCitationHighlight(event: { currentTarget: HTMLElement }) {
  const element = event.currentTarget;
  const key = element.dataset.citationLinkKey;
  if (!key) return;
  const matches = element.ownerDocument.querySelectorAll<HTMLElement>(
    `[data-citation-link-key="${CSS.escape(key)}"]`,
  );
  const active = Array.from(matches).some((match) => match.matches(":hover, :focus-within"));
  for (const match of matches) match.toggleAttribute("data-citation-highlight", active);
}

export function AssistantCitationMarkers({
  viewport,
  prompt,
  richTextEnabled,
  showingDraft = true,
  onOpen,
}: {
  viewport: HTMLElement | null;
  prompt: string;
  richTextEnabled: boolean;
  showingDraft?: boolean;
  onOpen: (key: string, anchor: AssistantCitationSourceAnchor) => void;
}) {
  const citationJson = JSON.stringify(
    showingDraft && prompt.includes("[Assistant quote](t3-citation://v1/")
      ? draftCitationMarkers(buildDocJson(prompt, () => null, { styling: richTextEnabled }))
      : [],
  );
  return <CitationMarkers viewport={viewport} citationJson={citationJson} onOpen={onOpen} />;
}

function CitationMarkers({
  viewport,
  citationJson,
  onOpen,
}: {
  viewport: HTMLElement | null;
  citationJson: string;
  onOpen: (key: string, anchor: AssistantCitationSourceAnchor) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const citations = JSON.parse(citationJson) as ReturnType<typeof draftCitationMarkers>;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions markers against rendered source ranges as the timeline scrolls and virtualizes rows
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!viewport || !overlay || citations.length === 0) return;
    let frame: number | null = null;
    viewport.setAttribute("data-has-draft-citations", "");
    const anchors = new Map<string, AssistantCitationSourceAnchor | null>();
    const update = () => {
      frame = null;
      const bounds = viewport.getBoundingClientRect();
      const occurrences = new Map<string, number>();
      let resolvedSource = false;
      for (const [index, marker] of citations.entries()) {
        const { citation, key } = marker;
        const button = overlay.children[index] as HTMLButtonElement;
        if (!anchors.has(key)) {
          const anchor = findAssistantCitationSourceAnchor(viewport, citation);
          anchors.set(key, anchor);
          resolvedSource = true;
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
        if (rect && anchor) {
          const sourceRight = anchor.source.getBoundingClientRect().right;
          const rectKey = `${sourceRight}:${rect.bottom}`;
          const occurrence = occurrences.get(rectKey) ?? 0;
          occurrences.set(rectKey, occurrence + 1);
          const width = button.offsetWidth;
          const height = button.offsetHeight;
          const base = Math.max(0, sourceRight - bounds.left + 3);
          const columns = Math.max(1, Math.floor((bounds.width - base + 2) / (width + 2)));
          const left = base + (occurrence % columns) * (width + 2);
          const top =
            Math.max(0, rect.bottom - bounds.top - height) +
            Math.floor(occurrence / columns) * (height + 2);
          button.style.left = `${left}px`;
          button.style.top = `${top}px`;
        }
      }
      if (resolvedSource) rebuildSourceObservations();
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    const stopResize = observeResize(viewport, schedule);
    let stopSourceResize = () => {};
    const invalidateText = (records: MutationRecord[]) => {
      for (const [key, anchor] of anchors) {
        if (anchor && records.some((record) => anchor.source.contains(record.target)))
          anchors.delete(key);
      }
    };
    const rebuildSourceObservations = () => {
      invalidateText(sourceMutations.takeRecords());
      sourceMutations.disconnect();
      stopSourceResize();
      const geometry = new Set<Element>();
      for (const anchor of anchors.values()) {
        for (
          let node: Element | null = anchor?.source ?? null;
          node && node !== viewport;
          node = node.parentElement
        )
          geometry.add(node);
      }
      stopSourceResize = observeResize([...geometry], schedule);
      for (const anchor of anchors.values()) {
        if (anchor) sourceMutations.observe(anchor.source, { subtree: true, characterData: true });
      }
    };
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
      rebuildSourceObservations();
      schedule();
    });
    mutations.observe(viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    const sourceMutations = new MutationObserver((records) => {
      invalidateText(records);
      rebuildSourceObservations();
      schedule();
    });
    for (const marker of citations) {
      const { citation, key } = marker;
      const anchor = findAssistantCitationSourceAnchor(viewport, citation);
      anchors.set(key, anchor);
      if (anchor) sourceMutations.observe(anchor.source, { subtree: true, characterData: true });
    }
    rebuildSourceObservations();
    viewport.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      viewport.removeAttribute("data-has-draft-citations");
      stopSourceResize();
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
      {citations.map(({ citation, key, number }) => (
        <Badge
          key={key}
          data-citation-marker-key={key}
          data-citation-link-key={key}
          onPointerEnter={updateCitationHighlight}
          onPointerLeave={updateCitationHighlight}
          onFocus={updateCitationHighlight}
          onBlur={updateCitationHighlight}
          render={<button type="button" />}
          hidden={!viewport}
          className="pointer-events-auto absolute data-[citation-highlight]:ring-2 data-[citation-highlight]:ring-ring data-[citation-highlight]:ring-offset-2 data-[citation-highlight]:ring-offset-background"
          aria-label={`Edit citation ${number} comment`}
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
          {number}
        </Badge>
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
