/**
 * Per-frame paint primitives for the planning renderer (spec §9): the node
 * transform/opacity/band writer and the SVG edge writer, plus the engine node
 * record type/factory. Pure DOM mutation keyed off cached last-written values so
 * the rAF loop only touches the DOM on change. Split out of
 * t3work-planningSpaceRenderer.ts.
 */

import {
  type PlanningBand,
  type PlanningCamera,
  type Viewport,
  Z_EPIC,
  Z_STORY,
  bandForScale,
  counterScale,
  epicCounterScale,
  scaleForPlane,
} from "./t3work-planningSpaceScene";

export type EngineNodeKind = "frame" | "epic" | "owner";

export interface EngineNode {
  readonly id: string;
  readonly kind: EngineNodeKind;
  readonly el: HTMLElement;
  readonly inner: HTMLElement | null;
  targetX: number;
  targetY: number;
  worldX: number;
  worldY: number;
  band: number;
  visible: boolean;
  screenX: number;
  screenY: number;
  lastOpacity: number;
  lastTransform: string;
  lastInnerTransform: string;
  lastOpacityStyle: string;
  lastVisibility: string;
}

export interface EngineEdge {
  readonly el: SVGLineElement;
  readonly fromId: string;
  readonly toId: string;
}

export type EdgePaintCache = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  opacity: string;
};

export const CAMERA_LERP = 0.1;
export const NODE_LERP = 0.16;
export const OFFSCREEN_MARGIN = 520;

export function createEngineNode(
  id: string,
  kind: EngineNodeKind,
  el: HTMLElement,
  inner: HTMLElement | null,
  existing: EngineNode | undefined,
): EngineNode {
  const sameEl = existing?.el === el;
  return {
    id,
    kind,
    el,
    inner,
    targetX: existing?.targetX ?? 0,
    targetY: existing?.targetY ?? 0,
    worldX: existing?.worldX ?? 0,
    worldY: existing?.worldY ?? 0,
    band: existing?.band ?? -1,
    visible: existing?.visible ?? true,
    screenX: existing?.screenX ?? 0,
    screenY: existing?.screenY ?? 0,
    lastOpacity: existing?.lastOpacity ?? 1,
    lastTransform: sameEl ? (existing?.lastTransform ?? "") : "",
    lastInnerTransform: sameEl ? (existing?.lastInnerTransform ?? "") : "",
    lastOpacityStyle: sameEl ? (existing?.lastOpacityStyle ?? "") : "",
    lastVisibility: sameEl ? (existing?.lastVisibility ?? "") : "",
  };
}

export function paintPlanningNodes(input: {
  nodes: Iterable<EngineNode>;
  camera: PlanningCamera;
  viewport: Viewport;
  storyScale: number;
  globalBand: PlanningBand;
  dimmedIds: ReadonlySet<string> | null;
}): void {
  const { camera, viewport, storyScale, globalBand, dimmedIds } = input;
  for (const node of input.nodes) {
    node.worldX += (node.targetX - node.worldX) * NODE_LERP;
    node.worldY += (node.targetY - node.worldY) * NODE_LERP;
    const planeZ = node.kind === "epic" ? Z_EPIC : Z_STORY;
    const scale = scaleForPlane(camera.z, planeZ);
    const screenX = (node.worldX - camera.x) * scale + viewport.width / 2;
    const screenY = (node.worldY - camera.y) * scale + viewport.height / 2;
    node.screenX = screenX;
    node.screenY = screenY;
    const offscreen =
      screenX < -OFFSCREEN_MARGIN ||
      screenX > viewport.width + OFFSCREEN_MARGIN ||
      screenY < -OFFSCREEN_MARGIN ||
      screenY > viewport.height + OFFSCREEN_MARGIN;
    node.visible = !offscreen;
    const visibility = offscreen ? "hidden" : "visible";
    const wasVisible = node.lastVisibility === "visible";
    if (visibility !== node.lastVisibility) {
      node.lastVisibility = visibility;
      node.el.style.visibility = visibility;
    }
    const band = node.kind === "frame" ? bandForScale(scale) : globalBand;
    if (!offscreen) {
      node.el.dataset["live"] = "true";
      if (band !== node.band || !wasVisible) {
        node.band = band;
        node.el.dataset["band"] = String(band);
      }
    } else {
      node.el.removeAttribute("data-live");
      node.band = band;
      continue;
    }
    let opacity = 1;
    if (node.kind === "epic") {
      opacity = Math.max(0, Math.min(1, (1.45 - storyScale) * 2.2));
    }
    if (dimmedIds && !dimmedIds.has(node.id)) {
      opacity *= 0.14;
    }
    node.lastOpacity = opacity;
    const opacityStyle = opacity.toFixed(3);
    if (opacityStyle !== node.lastOpacityStyle) {
      node.lastOpacityStyle = opacityStyle;
      node.el.style.opacity = opacityStyle;
    }
    const transform = `translate3d(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px, 0) scale(${scale.toFixed(4)})`;
    if (transform !== node.lastTransform) {
      node.lastTransform = transform;
      node.el.style.transform = transform;
    }
    if (node.inner) {
      // Epic labels must stay clearly readable however far out (§3.2).
      const frameBand = node.kind === "frame" ? band : globalBand;
      const inflate = node.kind === "epic" ? epicCounterScale(scale) : counterScale(frameBand, scale);
      const innerTransform = `translate(-50%, -50%) scale(${inflate.toFixed(4)})`;
      if (innerTransform !== node.lastInnerTransform) {
        node.lastInnerTransform = innerTransform;
        node.inner.style.transform = innerTransform;
      }
    }
  }
}

export function paintPlanningEdges(input: {
  edges: ReadonlyArray<EngineEdge>;
  nodes: ReadonlyMap<string, EngineNode>;
  edgePaint: WeakMap<SVGLineElement, EdgePaintCache>;
}): void {
  const { edges, nodes, edgePaint } = input;
  for (const edge of edges) {
    const from = nodes.get(edge.fromId);
    const to = nodes.get(edge.toId);
    if (!from || !to || !from.visible || !to.visible) {
      const cached = edgePaint.get(edge.el);
      if (!cached || cached.opacity !== "0") {
        edge.el.setAttribute("stroke-opacity", "0");
        edgePaint.set(edge.el, { x1: 0, y1: 0, x2: 0, y2: 0, opacity: "0" });
      }
      continue;
    }
    const endpointFactor = Math.min(from.lastOpacity, to.lastOpacity);
    const opacity = (0.32 * endpointFactor).toFixed(3);
    const cached = edgePaint.get(edge.el);
    if (
      cached &&
      cached.x1 === from.screenX &&
      cached.y1 === from.screenY &&
      cached.x2 === to.screenX &&
      cached.y2 === to.screenY &&
      cached.opacity === opacity
    ) {
      continue;
    }
    edge.el.setAttribute("x1", String(from.screenX));
    edge.el.setAttribute("y1", String(from.screenY));
    edge.el.setAttribute("x2", String(to.screenX));
    edge.el.setAttribute("y2", String(to.screenY));
    edge.el.setAttribute("stroke-opacity", opacity);
    edgePaint.set(edge.el, {
      x1: from.screenX,
      y1: from.screenY,
      x2: to.screenX,
      y2: to.screenY,
      opacity,
    });
  }
}
