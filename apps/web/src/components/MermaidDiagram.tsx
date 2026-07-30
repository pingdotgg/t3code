import { Minus, Plus, RotateCcw } from "lucide-react";
import {
  useEffect,
  useId,
  memo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { RenderResult } from "mermaid";

import { Button } from "./ui/button";

type MermaidTheme = "light" | "dark";

interface MermaidRenderState {
  readonly inputKey: string;
  readonly result: RenderResult | null;
}

export interface MermaidViewportTransform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface MermaidViewportBounds {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
}

interface MermaidDrag {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly transform: MermaidViewportTransform;
}

const MIN_MERMAID_SCALE = 0.5;
const MAX_MERMAID_SCALE = 3;
const MERMAID_ZOOM_STEP = 0.25;
const MERMAID_KEYBOARD_PAN_STEP = 24;
const DEFAULT_MERMAID_TRANSFORM: MermaidViewportTransform = { x: 0, y: 0, scale: 1 };

let mermaidRenderQueue: Promise<unknown> = Promise.resolve();

export function zoomMermaidTransform(
  transform: MermaidViewportTransform,
  change: number,
): MermaidViewportTransform {
  const scale = Math.min(
    MAX_MERMAID_SCALE,
    Math.max(MIN_MERMAID_SCALE, Math.round((transform.scale + change) * 100) / 100),
  );
  return { ...transform, scale };
}

export function panMermaidTransform(
  transform: MermaidViewportTransform,
  x: number,
  y: number,
): MermaidViewportTransform {
  return { ...transform, x, y };
}

export function constrainMermaidTransform(
  transform: MermaidViewportTransform,
  bounds: MermaidViewportBounds,
): MermaidViewportTransform {
  const maxX = Math.max(0, (bounds.contentWidth * transform.scale - bounds.viewportWidth) / 2);
  const maxY = Math.max(0, (bounds.contentHeight * transform.scale - bounds.viewportHeight) / 2);

  return {
    ...transform,
    x: maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, transform.x)),
    y: maxY === 0 ? 0 : Math.min(maxY, Math.max(-maxY, transform.y)),
  };
}

export function mermaidTransformStyle(transform: MermaidViewportTransform): string {
  return `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
}

export function renderMermaidDiagram(
  id: string,
  code: string,
  theme: MermaidTheme,
): Promise<RenderResult> {
  const render = async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
      darkMode: theme === "dark",
      fontFamily: "var(--font-sans)",
      logLevel: "fatal",
    });
    return mermaid.render(id, code);
  };

  const result = mermaidRenderQueue.then(render, render);
  mermaidRenderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export const MermaidDiagram = memo(function MermaidDiagram(props: {
  readonly code: string;
  readonly theme: MermaidTheme;
}) {
  const reactId = useId();
  const diagramId = `t3-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const inputKey = `${props.theme}\0${props.code}`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<MermaidViewportTransform>(DEFAULT_MERMAID_TRANSFORM);
  const dragRef = useRef<MermaidDrag | null>(null);
  const [renderState, setRenderState] = useState<MermaidRenderState | null>(null);
  const [scale, setScale] = useState(DEFAULT_MERMAID_TRANSFORM.scale);
  const [hasPan, setHasPan] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const stateForInput = renderState?.inputKey === inputKey ? renderState : null;
  const markdownSource = `\`\`\`mermaid\n${props.code.trimEnd()}\n\`\`\``;

  useEffect(() => {
    let active = true;

    void renderMermaidDiagram(diagramId, props.code, props.theme)
      .then((result) => {
        if (active) setRenderState({ inputKey, result });
      })
      .catch(() => {
        if (active) setRenderState({ inputKey, result: null });
      });

    return () => {
      active = false;
    };
  }, [diagramId, inputKey, props.code, props.theme]);

  useEffect(() => {
    if (!stateForInput?.result || !containerRef.current) return;
    transformRef.current = DEFAULT_MERMAID_TRANSFORM;
    containerRef.current.style.transform = mermaidTransformStyle(DEFAULT_MERMAID_TRANSFORM);
    dragRef.current = null;
    setScale(DEFAULT_MERMAID_TRANSFORM.scale);
    setHasPan(false);
    setIsPanning(false);
    stateForInput.result.bindFunctions?.(containerRef.current);
  }, [stateForInput]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const container = containerRef.current;
    if (!stateForInput?.result || !viewport || !container) return;

    const constrainCurrentTransform = () => {
      const transform = constrainMermaidTransform(transformRef.current, {
        viewportWidth: viewport.clientWidth,
        viewportHeight: viewport.clientHeight,
        contentWidth: container.offsetWidth,
        contentHeight: container.offsetHeight,
      });
      if (
        transform.x === transformRef.current.x &&
        transform.y === transformRef.current.y &&
        transform.scale === transformRef.current.scale
      ) {
        return;
      }

      transformRef.current = transform;
      container.style.transform = mermaidTransformStyle(transform);
      setHasPan(
        transform.x !== DEFAULT_MERMAID_TRANSFORM.x || transform.y !== DEFAULT_MERMAID_TRANSFORM.y,
      );
    };

    constrainCurrentTransform();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(constrainCurrentTransform);
    observer.observe(viewport);
    observer.observe(container);
    return () => observer.disconnect();
  }, [stateForInput]);

  function constrainToViewport(transform: MermaidViewportTransform): MermaidViewportTransform {
    const viewport = viewportRef.current;
    const container = containerRef.current;
    if (!viewport || !container) return transform;

    return constrainMermaidTransform(transform, {
      viewportWidth: viewport.clientWidth,
      viewportHeight: viewport.clientHeight,
      contentWidth: container.offsetWidth,
      contentHeight: container.offsetHeight,
    });
  }

  function applyTransform(
    transform: MermaidViewportTransform,
    updateScale: boolean,
  ): MermaidViewportTransform {
    const constrainedTransform = constrainToViewport(transform);
    transformRef.current = constrainedTransform;
    if (containerRef.current) {
      containerRef.current.style.transform = mermaidTransformStyle(constrainedTransform);
    }
    if (updateScale) {
      setScale(constrainedTransform.scale);
      setHasPan(
        constrainedTransform.x !== DEFAULT_MERMAID_TRANSFORM.x ||
          constrainedTransform.y !== DEFAULT_MERMAID_TRANSFORM.y,
      );
    }
    return constrainedTransform;
  }

  function changeZoom(change: number): void {
    applyTransform(zoomMermaidTransform(transformRef.current, change), true);
  }

  function resetViewport(): void {
    applyTransform(DEFAULT_MERMAID_TRANSFORM, true);
    setHasPan(false);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || (event.target as Element).closest("a, button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      transform: transformRef.current,
    };
    setIsPanning(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    applyTransform(
      panMermaidTransform(
        drag.transform,
        drag.transform.x + event.clientX - drag.clientX,
        drag.transform.y + event.clientY - drag.clientY,
      ),
      false,
    );
  }

  function stopPanning(event: ReactPointerEvent<HTMLDivElement>): void {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setHasPan(
      transformRef.current.x !== DEFAULT_MERMAID_TRANSFORM.x ||
        transformRef.current.y !== DEFAULT_MERMAID_TRANSFORM.y,
    );
    setIsPanning(false);
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? 0.1 : -0.1);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const transform = transformRef.current;
    let nextTransform: MermaidViewportTransform | null = null;

    switch (event.key) {
      case "+":
      case "=":
        changeZoom(MERMAID_ZOOM_STEP);
        break;
      case "-":
      case "_":
        changeZoom(-MERMAID_ZOOM_STEP);
        break;
      case "0":
        resetViewport();
        break;
      case "ArrowLeft":
        nextTransform = panMermaidTransform(
          transform,
          transform.x - MERMAID_KEYBOARD_PAN_STEP,
          transform.y,
        );
        break;
      case "ArrowRight":
        nextTransform = panMermaidTransform(
          transform,
          transform.x + MERMAID_KEYBOARD_PAN_STEP,
          transform.y,
        );
        break;
      case "ArrowUp":
        nextTransform = panMermaidTransform(
          transform,
          transform.x,
          transform.y - MERMAID_KEYBOARD_PAN_STEP,
        );
        break;
      case "ArrowDown":
        nextTransform = panMermaidTransform(
          transform,
          transform.x,
          transform.y + MERMAID_KEYBOARD_PAN_STEP,
        );
        break;
      default:
        return;
    }

    event.preventDefault();
    if (nextTransform) {
      const constrainedTransform = applyTransform(nextTransform, false);
      setHasPan(
        constrainedTransform.x !== DEFAULT_MERMAID_TRANSFORM.x ||
          constrainedTransform.y !== DEFAULT_MERMAID_TRANSFORM.y,
      );
    }
  }

  return (
    <div className="chat-markdown-mermaid" data-markdown-copy={markdownSource}>
      {stateForInput?.result ? (
        <>
          <div className="chat-markdown-mermaid-toolbar" role="toolbar" aria-label="Diagram zoom">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Zoom out diagram"
              title="Zoom out"
              disabled={scale <= MIN_MERMAID_SCALE}
              onClick={() => changeZoom(-MERMAID_ZOOM_STEP)}
            >
              <Minus />
            </Button>
            <span className="chat-markdown-mermaid-scale">{Math.round(scale * 100)}%</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Zoom in diagram"
              title="Zoom in"
              disabled={scale >= MAX_MERMAID_SCALE}
              onClick={() => changeZoom(MERMAID_ZOOM_STEP)}
            >
              <Plus />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Reset diagram pan and zoom"
              title="Reset pan and zoom"
              disabled={scale === DEFAULT_MERMAID_TRANSFORM.scale && !hasPan}
              onClick={resetViewport}
            >
              <RotateCcw />
            </Button>
          </div>
          <div
            ref={viewportRef}
            className="chat-markdown-mermaid-viewport"
            data-panning={isPanning}
            role="group"
            tabIndex={0}
            aria-label="Mermaid diagram. Drag to pan. Press plus or minus to zoom."
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopPanning}
            onPointerCancel={stopPanning}
            onWheel={handleWheel}
            onKeyDown={handleKeyDown}
          >
            <div
              ref={containerRef}
              className="chat-markdown-mermaid-svg"
              dangerouslySetInnerHTML={{ __html: stateForInput.result.svg }}
            />
          </div>
        </>
      ) : (
        <>
          {stateForInput ? (
            <div className="chat-markdown-mermaid-error" role="alert">
              Mermaid could not render this diagram.
            </div>
          ) : null}
          <pre>
            <code className="language-mermaid">{props.code}</code>
          </pre>
        </>
      )}
    </div>
  );
});
