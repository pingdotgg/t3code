import { Component, createElement, useCallback, useSyncExternalStore } from "react";
import type { ComponentType, CSSProperties, ErrorInfo, ReactNode } from "react";
import type { ExtensionHost, ViewSnapshot } from "./host.js";

export interface SurfaceRendererProps {
  readonly snapshot: ViewSnapshot;
}
export type SurfaceRenderer = ComponentType<SurfaceRendererProps>;
interface BoundaryProps {
  readonly children?: ReactNode;
  readonly fallback: ReactNode;
  readonly onError: (error: Error) => void;
}
class SurfaceBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error, _info: ErrorInfo) {
    this.props.onError(error);
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
/** Mount inside existing panel/dock chrome. Layout, focus and keyboard selection remain host-owned. */
export function ExtensionSurface(props: {
  readonly host: ExtensionHost<SurfaceRenderer>;
  readonly viewId: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly retainHiddenPresentation?: boolean;
  readonly fallback?: (snapshot: ViewSnapshot | null) => ReactNode;
}) {
  const { host, viewId } = props;
  const subscribe = useCallback(
    (notify: () => void) =>
      host.subscribe((_next, id) => {
        if (id === viewId) notify();
      }),
    [host, viewId],
  );
  const getSnapshot = useCallback(() => host.getSnapshot(viewId), [host, viewId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const fallback =
    props.fallback?.(snapshot) ??
    createElement(
      "div",
      { role: "status" },
      snapshot?.reason ?? snapshot?.record.fallback ?? "View closed",
    );
  const renderable = snapshot && (snapshot.status === "ready" || snapshot.status === "hidden");
  const Renderer = renderable ? host.renderer(viewId) : undefined;
  const hidden = snapshot?.status === "hidden";
  const concealed = hidden && !props.retainHiddenPresentation;
  return createElement(
    "div",
    {
      className: props.className,
      style: concealed ? { ...props.style, display: "none" } : props.style,
      hidden: concealed,
      inert: hidden,
      "aria-hidden": hidden || undefined,
      "data-extension-view": `${host.hostKey}:${viewId}`,
      "data-extension-surface": snapshot?.record.surfaceId,
    },
    Renderer && snapshot
      ? createElement(
          SurfaceBoundary,
          {
            key: `${viewId}:${snapshot.generation}`,
            fallback,
            onError: (error) => host.fail(viewId, error),
          },
          createElement(Renderer, { snapshot }),
        )
      : fallback,
  );
}
