import { useEffect, useRef, useState } from "react";
import type { AssistantCitationRequest, AssistantCitationTarget } from "./AssistantCitationSource";
import type { CitationPhase } from "./citationProcedure";

const CITATION_SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/** One activation of a citation; virtual row remounts and listeners share it. */
interface CitationNavigation {
  readonly target: AssistantCitationTarget;
  /** Takes over from the live follow for this activation. */
  readonly activate: () => void;
  /** Stops this activation for good once another one (or none) replaces it. */
  readonly retire: () => void;
  /** Listens for user navigation that stops this activation's pending scroll. */
  readonly attachDismissal: (viewport: HTMLElement | null) => () => void;
}

interface CitationSettlement {
  /** Per activation, not per key: Back/Forward can restore an earlier key. */
  readonly target: AssistantCitationTarget;
  /** Dismissed citations also drop their highlight; completed ones keep it. */
  readonly dismissed: boolean;
}

export function useAssistantCitationTarget({
  request,
  phase,
  viewport,
  onManualNavigation,
}: {
  request: AssistantCitationRequest | null;
  phase: CitationPhase | null;
  viewport: HTMLElement | null;
  onManualNavigation: () => void;
}) {
  const [settlement, setSettlement] = useState<CitationSettlement | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const onListLoad = () => setListLoaded(true);

  // Rows and listeners mutate the activation, so it lives as long as its
  // request; a target belongs to one request, so returning to an earlier key
  // never reuses it.
  const [navigation, setNavigation] = useState<CitationNavigation | null>(null);
  let current = navigation;
  if ((request?.key ?? null) !== (navigation?.target.key ?? null)) {
    current = request ? createCitationNavigation(request) : null;
    setNavigation(current);
  }
  function createCitationNavigation(next: AssistantCitationRequest): CitationNavigation {
    let done = false;
    const activationRef: AssistantCitationTarget["activationRef"] = {
      current: { scrolled: false, dismissed: false },
    };
    const target: AssistantCitationTarget = {
      ...next,
      activationRef,
      onComplete: () => {
        done = true;
        // The thread-open follow can run after the scroll started.
        onManualNavigation();
        setSettlement({ target, dismissed: false });
      },
    };
    const activate = () => {
      // The follow must yield before the citation row starts scrolling.
      if (!done) onManualNavigation();
    };
    const retire = () => {
      activationRef.current.dismissed = true;
      activationRef.current.cancelScroll?.();
    };
    const attachDismissal = (citationViewport: HTMLElement | null) => {
      // User navigation stops a pending citation scroll; Escape dismisses it outright.
      const dismiss = (onlyPending: boolean) => {
        const activation = activationRef.current;
        if (activation.dismissed || (onlyPending && (activation.scrolled || done))) return;
        activation.dismissed = true;
        activation.cancelScroll?.();
        if (!activation.scrolled && !done) onManualNavigation();
        done = true;
        setSettlement({ target, dismissed: true });
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          dismiss(false);
        } else if (
          CITATION_SCROLL_KEYS.has(event.key) &&
          event.target instanceof Node &&
          citationViewport?.contains(event.target)
        ) {
          dismiss(true);
        }
      };
      const onWheel = (event: WheelEvent) => {
        if (event.deltaY !== 0) dismiss(true);
      };
      const onNavigation = () => dismiss(true);
      document.addEventListener("keydown", onKeyDown);
      document.addEventListener("pointerdown", onNavigation, true);
      citationViewport?.addEventListener("wheel", onWheel, { passive: true });
      citationViewport?.addEventListener("touchmove", onNavigation, { passive: true });
      return () => {
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("pointerdown", onNavigation, true);
        citationViewport?.removeEventListener("wheel", onWheel);
        citationViewport?.removeEventListener("touchmove", onNavigation);
      };
    };
    return { target, activate, retire, attachDismissal };
  }

  // Retiring is one-way, so it runs when the activation is replaced rather than
  // in a cleanup: StrictMode and <Activity> replay cleanups on a live activation.
  // Unmounting needs no retire; the rows observing it unmount with the list.
  const activatedRef = useRef<CitationNavigation | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retires the replaced citation scroll and activates the new one, releasing the timeline follow
  useEffect(() => {
    if (activatedRef.current === current) return;
    activatedRef.current?.retire();
    activatedRef.current = current;
    current?.activate();
  }, [current]);
  // Escape and pointerdown dismiss before the viewport mounts; the viewport
  // listeners join once it exists.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes document and viewport listeners that dismiss the pending citation scroll
  useEffect(() => current?.attachDismissal(viewport), [current, viewport]);

  const settled = current !== null && settlement?.target === current.target ? settlement : null;
  const target =
    current !== null && phase?._tag === "ready" && listLoaded && settled?.dismissed !== true
      ? current.target
      : null;
  const positioning = current !== null && phase?._tag !== "failed" && settled === null;

  return {
    target,
    positioning,
    onListLoad,
    alwaysRender:
      target && positioning && phase?._tag === "ready" ? { keys: [phase.rowId] } : undefined,
  };
}
