import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";
import { observeResize } from "~/lib/observeResize";
import { readContextStripCompaction } from "../BranchToolbar.logic";
import {
  resolveRestingComposerControlsLayout,
  type RestingComposerControlsLayout,
} from "../composerFooterLayout";
import { useLayoutEffect, useRef, useState } from "react";

const CONTEXT_STRIP_SELECTOR = '[data-slot="composer-tray-row"]';
const CONTEXT_STRIP_LABEL_SELECTOR = "[data-composer-label]";

export function useRestingComposerControlsLayout(
  host: HTMLDivElement | null,
  useControlsAsHost = false,
) {
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const attachControls = (element: HTMLDivElement | null) => {
    controlsRef.current = element;
    setControls(element);
  };
  const [layout, setLayout] = useState<RestingComposerControlsLayout>({
    hiddenCount: 0,
    visible: true,
  });
  const stripSettlingRef = useRef(false);

  const measure = () => {
    const currentHost = useControlsAsHost ? controls : host;
    if (currentHost === null || !controls) return;
    // A hidden tab still lays out at the full stage width. Measuring it there
    // leaves labels sized for that width, and no resize corrects them once the
    // tab returns at its old size.
    if (!controls.checkVisibility()) return;

    const measurement = measureRestingComposerControls(controls);
    if (!measurement) return;
    const strip = controls.closest<HTMLElement>(CONTEXT_STRIP_SELECTOR);
    const stripMotion = strip
      ? Array.from(strip.querySelectorAll(CONTEXT_STRIP_LABEL_SELECTOR)).flatMap((label) =>
          label.getAnimations().filter((animation) => animation.playState === "running"),
        )
      : [];
    if (stripMotion.length > 0) {
      if (stripSettlingRef.current) return;
      stripSettlingRef.current = true;
      void Promise.allSettled(stripMotion.map((animation) => animation.finished)).then(() => {
        stripSettlingRef.current = false;
        measure();
      });
      return;
    }
    const style = getComputedStyle(currentHost);
    const hostWidth =
      currentHost.clientWidth -
      (Number.parseFloat(style.paddingInlineStart) || 0) -
      (Number.parseFloat(style.paddingInlineEnd) || 0);

    setLayout((current) => {
      const next = resolveRestingComposerControlsLayout({
        ...measurement,
        hostWidth,
        previous: current,
        ...(strip ? { stripCompaction: readContextStripCompaction(strip.dataset.compact) } : {}),
      });
      return next.hiddenCount === current.hiddenCount &&
        next.iconOnlyCount === current.iconOnlyCount &&
        next.traitsIconOnly === current.traitsIconOnly &&
        next.pickerIconOnly === current.pickerIconOnly &&
        next.visible === current.visible
        ? current
        : next;
    });
  };

  // Measure in ResizeObserver after layout is computed, then commit before paint. Mount or mutation
  // measurements would force the whole chat to lay out.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes control resize, DOM mutations and font loading to measure which controls fit
  useLayoutEffect(() => {
    const currentHost = useControlsAsHost ? controls : host;
    if (!currentHost || !controls) return;
    let stopObserving = () => {};
    const observeControls = () => {
      stopObserving();
      stopObserving = observeResize(
        [
          currentHost,
          controls,
          ...controls.querySelectorAll<HTMLElement>(
            "[data-resting-block], [data-composer-control-label], [data-chat-provider-model-picker-label]",
          ),
        ],
        measure,
      );
    };
    observeControls();
    const mutations = new MutationObserver(observeControls);
    mutations.observe(controls, { childList: true, subtree: true, characterData: true });
    const stripMutations = new MutationObserver(measure);
    const strip = controls.closest(CONTEXT_STRIP_SELECTOR);
    if (strip) stripMutations.observe(strip, { attributeFilter: ["data-compact"] });
    document.fonts.addEventListener("loadingdone", observeControls);
    return () => {
      stopObserving();
      mutations.disconnect();
      stripMutations.disconnect();
      document.fonts.removeEventListener("loadingdone", observeControls);
    };
  }, [host, controls, useControlsAsHost, measure]);

  return {
    controlsRef,
    attachControls,
    hiddenBlockCount: layout.hiddenCount,
    iconOnlyBlockCount: layout.iconOnlyCount ?? 0,
    traitsIconOnly: layout.traitsIconOnly ?? false,
    pickerIconOnly: layout.pickerIconOnly ?? false,
    controlsVisible: layout.visible,
  };
}
