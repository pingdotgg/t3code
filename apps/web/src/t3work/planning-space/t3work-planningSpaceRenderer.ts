/**
 * Planning space renderer engine (spec §9): owns the rAF loop, camera lerping
 * and DOM transform application — React renders node DOM once per data change,
 * this engine only mutates transforms/opacities/band attrs/edge endpoints.
 * Per-frame paint primitives live in t3work-planningSpaceRendererPaint.ts.
 */

import {
  type PlanningCamera,
  type SceneBounds,
  type Viewport,
  type WorldPoint,
  Z_STORY,
  bandForScale,
  cursorAnchoredZoom,
  fitCameraToBounds,
  pinchZoom,
  scaleForPlane,
  unprojectAtStoryPlane,
} from "./t3work-planningSpaceScene";
import {
  CAMERA_LERP,
  type EdgePaintCache,
  type EngineEdge,
  type EngineNode,
  type EngineNodeKind,
  createEngineNode,
  paintPlanningEdges,
  paintPlanningNodes,
} from "./t3work-planningSpaceRendererPaint";

export type { EngineEdge, EngineNodeKind } from "./t3work-planningSpaceRendererPaint";

export class PlanningSpaceEngine {
  private readonly nodes = new Map<string, EngineNode>();
  private edges: EngineEdge[] = [];
  private readonly edgePaint = new WeakMap<SVGLineElement, EdgePaintCache>();
  private readonly frameListeners = new Set<() => void>();
  private camera: PlanningCamera = { x: 0, y: 0, z: -900 };
  private cameraTarget: PlanningCamera = { x: 0, y: 0, z: -400 };
  private rafHandle: number | null = null;
  private zMinValue = -6400;
  private fitRequest: SceneBounds | null = null;
  private dimmedIds: ReadonlySet<string> | null = null;
  private onBandChange: ((band: number) => void) | null = null;
  private lastGlobalBand = -1;

  constructor(private readonly stage: HTMLElement) {}

  get zMin(): number {
    return this.zMinValue;
  }

  get cameraZTarget(): number {
    return this.cameraTarget.z;
  }

  get cameraTargetSnapshot(): PlanningCamera {
    return { ...this.cameraTarget };
  }

  viewport(): Viewport {
    return { width: this.stage.clientWidth, height: this.stage.clientHeight };
  }

  setBandChangeListener(listener: (band: number) => void): void {
    this.onBandChange = listener;
  }

  /** Run after each painted frame (gauge marker, magnets, leader lines). */
  addFrameListener(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  registerNode(id: string, kind: EngineNodeKind, el: HTMLElement, inner: HTMLElement | null): void {
    this.nodes.set(id, createEngineNode(id, kind, el, inner, this.nodes.get(id)));
  }

  unregisterNode(id: string): void {
    this.nodes.delete(id);
  }

  /** Drop all node registrations (engine teardown only). */
  resetNodes(): void {
    this.nodes.clear();
  }

  /** Remove engine nodes that no longer exist in the scene DOM. */
  pruneNodes(keepIds: ReadonlySet<string>): void {
    for (const id of this.nodes.keys()) {
      if (!keepIds.has(id)) this.nodes.delete(id);
    }
  }

  setTargets(positions: ReadonlyMap<string, { x: number; y: number }>): void {
    for (const [id, position] of positions) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const isNew = node.targetX === 0 && node.targetY === 0 && node.worldX === 0;
      node.targetX = position.x;
      node.targetY = position.y;
      if (isNew) {
        node.worldX = position.x * 1.15;
        node.worldY = position.y * 1.15;
      }
    }
  }

  setEdges(edges: ReadonlyArray<EngineEdge>): void {
    this.edges = [...edges];
  }

  setDimmedIds(ids: ReadonlySet<string> | null): void {
    this.dimmedIds = ids;
  }

  panByScreenDelta(dx: number, dy: number): void {
    this.fitRequest = null;
    const scale = scaleForPlane(this.cameraTarget.z, Z_STORY);
    this.cameraTarget = {
      x: this.cameraTarget.x - dx / scale,
      y: this.cameraTarget.y - dy / scale,
      z: this.cameraTarget.z,
    };
  }

  pinchZoomAt(centerX: number, centerY: number, ratio: number): void {
    this.cameraTarget = pinchZoom(this.cameraTarget, this.viewport(), centerX, centerY, ratio, this.zMinValue);
  }

  setCameraTarget(camera: PlanningCamera): void {
    // An explicit target supersedes any queued fit (otherwise the fit applies
    // a frame later and silently overrides the restore).
    this.fitRequest = null;
    this.cameraTarget = { ...camera };
  }

  zoomAtCursor(cursorX: number, cursorY: number, wheelDeltaY: number): void {
    this.fitRequest = null;
    this.cameraTarget = cursorAnchoredZoom(
      this.cameraTarget,
      this.viewport(),
      cursorX,
      cursorY,
      wheelDeltaY,
      this.zMinValue,
    );
  }

  setCameraZ(z: number): void {
    this.fitRequest = null;
    this.cameraTarget = { ...this.cameraTarget, z };
  }

  /**
   * Keep the camera fitted to these bounds (recomputed each frame from the live
   * viewport) until the user navigates — immune to late layout/panel resizes.
   */
  requestFit(bounds: SceneBounds): void {
    this.fitRequest = bounds;
  }

  fitBounds(bounds: SceneBounds): void {
    this.requestFit(bounds);
  }

  flyTo(x: number, y: number, z?: number): void {
    this.fitRequest = null;
    this.cameraTarget = { x, y, z: z ?? this.cameraTarget.z };
  }

  unprojectAtStoryPlane(screenX: number, screenY: number): WorldPoint {
    return unprojectAtStoryPlane(this.camera, this.viewport(), screenX, screenY);
  }

  screenPositionOf(id: string): { x: number; y: number } | null {
    const node = this.nodes.get(id);
    if (!node || !node.visible) return null;
    return { x: node.screenX, y: node.screenY };
  }

  start(): void {
    if (this.rafHandle !== null) return;
    const tick = () => {
      this.frame();
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }

  private frame(): void {
    const viewport = this.viewport();
    if (viewport.width === 0) return;
    if (this.fitRequest) {
      this.cameraTarget = fitCameraToBounds(this.fitRequest, viewport);
      this.zMinValue = Math.min(this.zMinValue, this.cameraTarget.z - 60);
    }
    this.camera = {
      x: this.camera.x + (this.cameraTarget.x - this.camera.x) * CAMERA_LERP,
      y: this.camera.y + (this.cameraTarget.y - this.camera.y) * CAMERA_LERP,
      z: this.camera.z + (this.cameraTarget.z - this.camera.z) * CAMERA_LERP,
    };
    const storyScale = scaleForPlane(this.camera.z, Z_STORY);
    const globalBand = bandForScale(storyScale);
    if (globalBand !== this.lastGlobalBand) {
      this.lastGlobalBand = globalBand;
      this.onBandChange?.(globalBand);
    }
    paintPlanningNodes({
      nodes: this.nodes.values(),
      camera: this.camera,
      viewport,
      storyScale,
      globalBand,
      dimmedIds: this.dimmedIds,
    });
    paintPlanningEdges({ edges: this.edges, nodes: this.nodes, edgePaint: this.edgePaint });
    for (const listener of this.frameListeners) {
      listener();
    }
  }
}
