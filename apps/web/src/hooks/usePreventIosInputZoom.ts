import { useCallback, useEffect, useMemo, useRef } from "react";

const DEFAULT_VIEWPORT_CONTENT = "width=device-width, initial-scale=1.0";
const IOS_USER_AGENT_PATTERN = /\b(iPad|iPhone|iPod)\b/i;
const VIEWPORT_META_SELECTOR = 'meta[name="viewport"]';

export function isIosInputZoomPlatform(input: {
  maxTouchPoints: number;
  platform: string;
  userAgent: string;
}): boolean {
  return (
    IOS_USER_AGENT_PATTERN.test(input.userAgent) ||
    (input.platform === "MacIntel" && input.maxTouchPoints > 1)
  );
}

export function buildInputZoomLockedViewportContent(content: string): string {
  const baseContent = content.trim() || DEFAULT_VIEWPORT_CONTENT;
  const segments = baseContent
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const filteredSegments = segments.filter((segment) => {
    const [key] = segment.split("=", 1);
    const normalizedKey = key?.trim().toLowerCase();
    return normalizedKey !== "maximum-scale" && normalizedKey !== "user-scalable";
  });

  filteredSegments.push("maximum-scale=1", "user-scalable=no");
  return filteredSegments.join(", ");
}

export function usePreventIosInputZoom(): {
  onBlur: () => void;
  onFocus: () => void;
  onTouchStartCapture: () => void;
} {
  const isEnabled = useMemo(() => {
    if (typeof navigator === "undefined") {
      return false;
    }

    return isIosInputZoomPlatform({
      maxTouchPoints: navigator.maxTouchPoints,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
    });
  }, []);
  const focusedRef = useRef(false);
  const lockStateRef = useRef<{
    isLocked: boolean;
    originalContent: string | null;
    viewportMeta: HTMLMetaElement | null;
  }>({
    isLocked: false,
    originalContent: null,
    viewportMeta: null,
  });

  const restoreViewport = useCallback(() => {
    const lockState = lockStateRef.current;
    if (!lockState.isLocked) {
      return;
    }

    if (lockState.viewportMeta && lockState.originalContent != null) {
      lockState.viewportMeta.setAttribute("content", lockState.originalContent);
    }

    lockState.isLocked = false;
    lockState.originalContent = null;
    lockState.viewportMeta = null;
  }, []);

  const lockViewport = useCallback(() => {
    if (!isEnabled || typeof document === "undefined") {
      return;
    }

    const lockState = lockStateRef.current;
    if (lockState.isLocked) {
      return;
    }

    const viewportMeta = document.querySelector<HTMLMetaElement>(VIEWPORT_META_SELECTOR);
    if (!viewportMeta) {
      return;
    }

    lockState.isLocked = true;
    lockState.originalContent = viewportMeta.getAttribute("content") ?? DEFAULT_VIEWPORT_CONTENT;
    lockState.viewportMeta = viewportMeta;
    viewportMeta.setAttribute(
      "content",
      buildInputZoomLockedViewportContent(lockState.originalContent),
    );
  }, [isEnabled]);

  const handleTouchStartCapture = useCallback(() => {
    lockViewport();
    requestAnimationFrame(() => {
      if (!focusedRef.current) {
        restoreViewport();
      }
    });
  }, [lockViewport, restoreViewport]);

  const handleFocus = useCallback(() => {
    focusedRef.current = true;
    lockViewport();
  }, [lockViewport]);

  const handleBlur = useCallback(() => {
    focusedRef.current = false;
    restoreViewport();
  }, [restoreViewport]);

  useEffect(() => restoreViewport, [restoreViewport]);

  return {
    onBlur: handleBlur,
    onFocus: handleFocus,
    onTouchStartCapture: handleTouchStartCapture,
  };
}
