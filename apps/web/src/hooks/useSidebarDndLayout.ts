import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

interface PendingAnchor {
  readonly node: HTMLElement;
  top: number;
}

export interface SidebarDndLayout {
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly handleEntryNodeChange: (id: string, node: HTMLElement | null) => void;
  readonly getEntryNode: (id: string) => HTMLElement | null;
  readonly captureEntryPosition: (id: string | null) => void;
}

export function useSidebarDndLayout(revision: unknown): SidebarDndLayout {
  const viewportRef = useRef<HTMLDivElement>(null);
  const entryNodesRef = useRef(new Map<string, HTMLElement>());
  const pendingAnchorRef = useRef<PendingAnchor | null>(null);

  const handleEntryNodeChange = useCallback((id: string, node: HTMLElement | null) => {
    if (node === null) entryNodesRef.current.delete(id);
    else entryNodesRef.current.set(id, node);
  }, []);
  const getEntryNode = useCallback((id: string) => entryNodesRef.current.get(id) ?? null, []);
  const captureEntryPosition = useCallback((id: string | null) => {
    const node = id === null ? null : (entryNodesRef.current.get(id) ?? null);
    pendingAnchorRef.current =
      node === null || !node.isConnected ? null : { node, top: node.getBoundingClientRect().top };
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const anchor = pendingAnchorRef.current;
    pendingAnchorRef.current = null;
    if (viewport === null || anchor === null || !anchor.node.isConnected) return;

    const delta = anchor.node.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 0.5) viewport.scrollTop += delta;
  }, [revision]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const handleScroll = () => {
      const anchor = pendingAnchorRef.current;
      if (anchor === null || !anchor.node.isConnected) return;
      anchor.top = anchor.node.getBoundingClientRect().top;
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, []);

  return {
    viewportRef,
    handleEntryNodeChange,
    getEntryNode,
    captureEntryPosition,
  };
}
