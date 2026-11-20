import type { ModelPreviewKind } from "@t3tools/shared/filePreview";
import {
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Spherical,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { observeResize } from "~/lib/observeResize";

import { PreviewError } from "./previewFailure";
import type { ModelCameraView, ModelCapture, ModelNote, Vec3 } from "./modelAnnotations";

/** Larger files are refused before parsing, which runs on the main thread. */
const MAX_MODEL_BYTES = 128 * 1024 * 1024;

export type ModelViewPreset = "top" | "front" | "iso";

interface ModelSummary {
  readonly format: ModelPreviewKind;
  readonly triangles: number;
  /** Bounding box size in the file's own units. */
  readonly size: Vec3;
  /** Changes whenever the geometry does, so notes can tell they no longer match. */
  readonly fingerprint: string;
}

export interface ModelHit {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly face: number;
}

interface ProjectedPin {
  readonly x: number;
  readonly y: number;
  /** The pinned surface faces away from the camera. */
  readonly behind: boolean;
}

/** Reads a model file with a byte cap; aborting cancels the transfer. */
async function fetchModelBytes(src: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(src, { signal });
  if (!response.ok || !response.body) throw new PreviewError({ code: "file-unavailable" });
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_MODEL_BYTES) throw new PreviewError({ code: "document-too-large" });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MODEL_BYTES) {
      void reader.cancel();
      throw new PreviewError({ code: "document-too-large" });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

// Loaders load with the format that needs them, so opening an STL never pulls in glTF.
async function parseModel(format: ModelPreviewKind, bytes: ArrayBuffer): Promise<Object3D> {
  switch (format) {
    case "stl": {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      const geometry = new STLLoader().parse(bytes);
      // Many exporters write zero face normals, which light as black; derive them instead.
      geometry.computeVertexNormals();
      const material = new MeshStandardMaterial({
        color: new Color(0x9aa0aa),
        metalness: 0.05,
        roughness: 0.7,
        vertexColors: geometry.hasAttribute("color"),
      });
      return new Mesh(geometry, material);
    }
    case "3mf": {
      const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
      return new ThreeMFLoader().parse(bytes);
    }
    case "glb": {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader().parseAsync(bytes, "");
      return gltf.scene;
    }
  }
}

function countTriangles(root: Object3D): number {
  let triangles = 0;
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry as BufferGeometry;
    const count = geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
    triangles += Math.floor(count / 3);
  });
  return triangles;
}

function disposeMaterial(material: Material) {
  for (const value of Object.values(material)) {
    if (value instanceof Texture) {
      const data: unknown = value.source.data;
      if (typeof ImageBitmap !== "undefined" && data instanceof ImageBitmap) data.close();
      value.dispose();
    }
  }
  material.dispose();
}

/** Frees GPU buffers, textures and materials under `root`. */
function disposeObject(root: Object3D) {
  root.traverse((object) => {
    const disposable = object as Partial<Mesh>;
    disposable.geometry?.dispose();
    const material = disposable.material;
    if (Array.isArray(material)) material.forEach(disposeMaterial);
    else if (material) disposeMaterial(material);
  });
}

const toVec3 = (vector: Vector3): Vec3 => [vector.x, vector.y, vector.z];

/**
 * One model on one canvas. It renders only when something changes (camera, size,
 * wireframe, visibility), never in an idle loop, and frees every GPU resource on dispose.
 */
export class ModelScene {
  readonly summary: ModelSummary;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(40, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  /** The file's own coordinate space; notes are stored relative to it. */
  private readonly content: Object3D;
  private readonly container: HTMLElement;
  private readonly radius: number;
  private readonly stopResizeObserver: () => void;
  private readonly visibilityObserver: IntersectionObserver;
  private visible = true;
  private frame: number | null = null;
  private disposed = false;
  private onFrame: () => void = () => undefined;

  private constructor(container: HTMLElement, format: ModelPreviewKind, content: Object3D) {
    this.content = content;
    this.container = container;
    const frame = new Group();
    // STL and 3MF are Z-up; glTF is Y-up like three.js.
    if (format !== "glb") content.rotation.x = -Math.PI / 2;
    frame.add(content);
    frame.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(frame);
    const center = bounds.getCenter(new Vector3());
    frame.position.sub(center);
    frame.updateMatrixWorld(true);
    const size = bounds.getSize(new Vector3());
    this.radius = Math.max(size.length() / 2, 1e-3);
    this.scene.add(frame);

    const localBounds = new Box3();
    content.updateMatrixWorld(true);
    const toContent = new Matrix4().copy(content.matrixWorld).invert();
    localBounds.copy(bounds).applyMatrix4(toContent);
    const localSize = localBounds.getSize(new Vector3());
    const triangles = countTriangles(content);
    this.summary = {
      format,
      triangles,
      size: toVec3(localSize),
      fingerprint: [triangles, ...toVec3(localBounds.min), ...toVec3(localBounds.max)]
        .map((value) => Number(value.toPrecision(6)))
        .join(":"),
    };

    // A translucent neutral grid reads on both light and dark theme backgrounds.
    const grid = new GridHelper(this.radius * 4, 16, 0x808080, 0x808080);
    grid.material.transparent = true;
    grid.material.opacity = 0.3;
    grid.position.y = -size.y / 2;
    this.scene.add(grid);
    this.scene.add(new HemisphereLight(0xffffff, 0x303040, 1.4));
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 2, 3);
    this.camera.add(key);
    this.scene.add(this.camera);

    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.className = "block size-full touch-none outline-none";
    container.append(this.renderer.domElement);

    this.camera.near = this.radius / 100;
    this.camera.far = this.radius * 100;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener("change", this.requestRender);
    this.setPreset("iso");

    this.stopResizeObserver = observeResize(container, () => this.resize());
    this.visibilityObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry?.isIntersecting ?? true;
      if (this.visible) this.requestRender();
    });
    this.visibilityObserver.observe(container);
    this.resize();
  }

  /** Fetches, parses and mounts a model; aborting before it finishes frees what it made. */
  static async load(input: {
    readonly container: HTMLElement;
    readonly src: string;
    readonly format: ModelPreviewKind;
    readonly signal: AbortSignal;
  }): Promise<ModelScene> {
    const bytes = await fetchModelBytes(input.src, input.signal);
    input.signal.throwIfAborted();
    let content: Object3D;
    try {
      content = await parseModel(input.format, bytes);
    } catch {
      throw new PreviewError({ code: "model-invalid" });
    }
    if (input.signal.aborted || countTriangles(content) === 0) {
      disposeObject(content);
      input.signal.throwIfAborted();
      throw new PreviewError({ code: "model-invalid" });
    }
    try {
      return new ModelScene(input.container, input.format, content);
    } catch {
      disposeObject(content);
      throw new PreviewError({ code: "model-webgl-unavailable" });
    }
  }

  /** Called after every rendered frame, to move overlays with the model. */
  setFrameListener(listener: () => void) {
    this.onFrame = listener;
  }

  requestRender = () => {
    if (this.disposed || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (!this.visible || this.disposed) return;
      this.renderNow();
    });
  };

  private renderNow() {
    this.renderer.render(this.scene, this.camera);
    this.onFrame();
  }

  private resize() {
    const { clientWidth: width, clientHeight: height } = this.container;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  setPreset(preset: ModelViewPreset | "fit") {
    const direction =
      preset === "top"
        ? new Vector3(0, 1, 0.0001)
        : preset === "front"
          ? new Vector3(0, 0, 1)
          : new Vector3(1, 0.8, 1.2);
    if (preset === "fit") {
      direction.copy(this.camera.position).sub(this.controls.target);
      if (direction.lengthSq() === 0) direction.set(1, 0.8, 1.2);
    }
    const distance = this.radius / Math.sin(((this.camera.fov / 2) * Math.PI) / 180);
    this.controls.target.set(0, 0, 0);
    this.camera.position.copy(direction.normalize().multiplyScalar(distance * 1.05));
    this.controls.update();
    this.requestRender();
  }

  get view(): ModelCameraView {
    return { position: toVec3(this.camera.position), target: toVec3(this.controls.target) };
  }

  setView(view: ModelCameraView) {
    this.camera.position.set(...view.position);
    this.controls.target.set(...view.target);
    this.controls.update();
    this.requestRender();
  }

  get cameraStatus() {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new Spherical().setFromVector3(offset);
    const degrees = (radians: number) => Math.round((radians * 180) / Math.PI);
    return {
      azimuth: degrees(spherical.theta),
      elevation: degrees(Math.PI / 2 - spherical.phi),
    };
  }

  setWireframe(on: boolean) {
    this.content.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const materials: Material[] = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of materials) {
        if ("wireframe" in material) material.wireframe = on;
      }
    });
    this.requestRender();
  }

  /** The surface under a viewport point, in the file's own coordinates. */
  pick(clientX: number, clientY: number): ModelHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const hit = raycaster.intersectObject(this.content, true)[0];
    if (!hit?.face) return null;
    const toContent = new Matrix4().copy(this.content.matrixWorld).invert();
    const normal = hit.face.normal
      .clone()
      .transformDirection(hit.object.matrixWorld)
      .transformDirection(toContent);
    return {
      point: toVec3(hit.point.clone().applyMatrix4(toContent)),
      normal: toVec3(normal),
      face: hit.faceIndex ?? 0,
    };
  }

  /** Where each note sits on the canvas, in CSS pixels from its top left corner. */
  project(notes: ReadonlyArray<ModelNote>): ProjectedPin[] {
    const width = this.renderer.domElement.clientWidth;
    const height = this.renderer.domElement.clientHeight;
    return notes.map((note) => {
      const world = new Vector3(...note.point).applyMatrix4(this.content.matrixWorld);
      const normal = new Vector3(...note.normal).transformDirection(this.content.matrixWorld);
      const toCamera = this.camera.position.clone().sub(world);
      const screen = world.clone().project(this.camera);
      return {
        x: ((screen.x + 1) / 2) * width,
        y: ((1 - screen.y) / 2) * height,
        behind: normal.dot(toCamera) < 0 || screen.z > 1,
      };
    });
  }

  /** A PNG of the current view with each live note drawn as its numbered pin. */
  capture(notes: ReadonlyArray<ModelNote>): ModelCapture {
    this.renderer.render(this.scene, this.camera);
    const source = this.renderer.domElement;
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d");
    if (!context) throw new PreviewError({ code: "model-invalid" });
    // The canvas is transparent over the themed background, so the capture paints that first.
    context.fillStyle = getComputedStyle(this.container).backgroundColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0);
    const scale = source.width / Math.max(1, source.clientWidth);
    const pins = this.project(notes);
    context.font = `600 ${11 * scale}px Inter, system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    notes.forEach((note, index) => {
      const pin = pins[index];
      if (!pin || note.stale) return;
      const x = pin.x * scale;
      const y = pin.y * scale;
      context.globalAlpha = pin.behind ? 0.5 : 1;
      context.beginPath();
      context.arc(x, y, 9 * scale, 0, Math.PI * 2);
      context.fillStyle = "#3b6ef5";
      context.fill();
      context.lineWidth = 2 * scale;
      context.strokeStyle = "#fff";
      context.stroke();
      context.fillStyle = "#fff";
      context.fillText(String(index + 1), x, y + 0.5 * scale);
    });
    context.globalAlpha = 1;
    return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.stopResizeObserver();
    this.visibilityObserver.disconnect();
    this.controls.removeEventListener("change", this.requestRender);
    this.controls.dispose();
    disposeObject(this.scene);
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
