import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type { ModelPreviewKind } from "@t3tools/shared/filePreview";
import {
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  LoadingManager,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Spherical,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { decodeDataUrl } from "../dataUrl.ts";
import { disposeThreeObject } from "../three/disposeObject.ts";
import type { ModelCameraView, ModelCapture, ModelNote, Vec3 } from "./annotations.ts";
import { unpackModelArchive } from "./archive.ts";
import { ModelPreviewError } from "./error.ts";

/** Callers refuse larger files before loading them; parsing runs on the main thread. */
export const MAX_MODEL_BYTES = 128 * 1024 * 1024;

export type ModelViewPreset = "top" | "front" | "iso";

interface ModelSummary {
  readonly format: ModelPreviewKind;
  readonly triangles: number;
  /** Bounding box size in the file's own units. */
  readonly size: Vec3;
  /** Content revision, including geometry, transforms and embedded assets. */
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

/** Turns a 3MF's bytes into the uncompressed ZIP ThreeMFLoader reads; web runs it in a worker. */
export type ModelArchiveUnpacker = (
  bytes: ArrayBuffer,
  signal: AbortSignal,
) => Promise<ArrayBuffer>;

async function parseModel(
  format: ModelPreviewKind,
  bytes: ArrayBuffer,
  signal: AbortSignal,
  unpackArchive: ModelArchiveUnpacker,
): Promise<Object3D> {
  switch (format) {
    case "stl": {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      const geometry = new STLLoader().parse(bytes);
      // Many exporters write zero face normals, which light as black; derive them instead.
      geometry.computeVertexNormals();
      // A recognised colour extension carries the full colour; others get a neutral grey.
      const colored = geometry.hasAttribute("color");
      const material = new MeshStandardMaterial({
        color: new Color(colored ? 0xffffff : 0x9aa0aa),
        metalness: 0.05,
        roughness: 0.7,
        vertexColors: colored,
      });
      return new Mesh(geometry, material);
    }
    case "3mf": {
      const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
      const archive = await unpackArchive(bytes, signal);
      signal.throwIfAborted();
      return new ThreeMFLoader().parse(archive);
    }
    case "glb": {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const inlineResources = new Map<string, string>();
      const manager = new LoadingManager().setURLModifier((url) => {
        if (/^blob:/i.test(url)) return url;
        const objectUrl = inlineResources.get(url);
        if (objectUrl) return objectUrl;
        throw new ModelPreviewError({ code: "model-invalid" });
      });
      try {
        const gltf = await new GLTFLoader(manager)
          .register((parser) => ({
            name: "self-contained-preview",
            beforeRoot: () => {
              const manifest: {
                buffers?: ReadonlyArray<{ uri?: unknown }>;
                images?: ReadonlyArray<{ uri?: unknown }>;
              } = parser.json;
              // Desktop allows blob fetches but blocks data URLs in connect-src.
              for (const part of [...(manifest.buffers ?? []), ...(manifest.images ?? [])]) {
                const { uri } = part;
                if (uri === undefined) continue;
                if (typeof uri !== "string" || !/^data:/i.test(uri)) {
                  throw new ModelPreviewError({ code: "model-invalid" });
                }
                if (!inlineResources.has(uri)) {
                  inlineResources.set(uri, URL.createObjectURL(decodeDataUrl(uri)));
                }
              }
              return Promise.resolve();
            },
          }))
          .parseAsync(bytes, "");
        return gltf.scene;
      } finally {
        for (const url of inlineResources.values()) URL.revokeObjectURL(url);
      }
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
  private readonly resizeObserver: ResizeObserver;
  private readonly visibilityObserver: IntersectionObserver;
  private visible = true;
  private frame: number | null = null;
  private disposed = false;
  private onFrame: () => void = () => undefined;

  private constructor(
    container: HTMLElement,
    format: ModelPreviewKind,
    content: Object3D,
    fingerprint: string,
  ) {
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
      fingerprint,
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
    // Inline, since a native WebView page has no app stylesheet.
    Object.assign(this.renderer.domElement.style, {
      display: "block",
      width: "100%",
      height: "100%",
      touchAction: "none",
      outline: "none",
    });
    container.append(this.renderer.domElement);

    this.camera.near = this.radius / 100;
    this.camera.far = this.radius * 100;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener("change", this.requestRender);
    this.resize();
    this.setPreset("iso");

    // Resizing touches only the canvas and camera; overlays follow on the next rendered frame.
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.visibilityObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry?.isIntersecting ?? true;
      if (this.visible) this.requestRender();
    });
    this.visibilityObserver.observe(container);
  }

  /**
   * Parses and mounts a model's bytes; aborting before it finishes frees what it made.
   * Rejects with `ModelPreviewError` for a file it cannot show, or the signal's reason.
   */
  static async load(input: {
    readonly container: HTMLElement;
    readonly bytes: ArrayBuffer;
    readonly format: ModelPreviewKind;
    readonly signal: AbortSignal;
    readonly unpackArchive?: ModelArchiveUnpacker;
  }): Promise<ModelScene> {
    const { bytes } = input;
    input.signal.throwIfAborted();
    // Insecure origins, such as a LAN server over http, have no SubtleCrypto.
    const digest = globalThis.crypto?.subtle
      ? new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))
      : sha256(new Uint8Array(bytes));
    input.signal.throwIfAborted();
    let content: Object3D;
    try {
      content = await parseModel(
        input.format,
        bytes,
        input.signal,
        input.unpackArchive ?? unpackModelArchive,
      );
    } catch {
      input.signal.throwIfAborted();
      throw new ModelPreviewError({ code: "model-invalid" });
    }
    if (input.signal.aborted || countTriangles(content) === 0) {
      disposeThreeObject(content);
      input.signal.throwIfAborted();
      throw new ModelPreviewError({ code: "model-invalid" });
    }
    try {
      return new ModelScene(input.container, input.format, content, bytesToHex(digest));
    } catch {
      disposeThreeObject(content);
      throw new ModelPreviewError({ code: "model-webgl-unavailable" });
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
    const vertical = (this.camera.fov * Math.PI) / 360;
    const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect);
    const distance = this.radius / Math.sin(Math.min(vertical, horizontal));
    this.camera.far = Math.max(this.radius * 100, distance * 2);
    this.camera.updateProjectionMatrix();
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
    const { width, height } = this.renderer.getSize(new Vector2());
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

  /**
   * A PNG of the current view with each live note drawn as its numbered pin. Empty space stays
   * transparent, so wherever it is shown later, that surface's theme shows through.
   */
  capture(notes: ReadonlyArray<ModelNote>): ModelCapture {
    this.renderer.render(this.scene, this.camera);
    const source = this.renderer.domElement;
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d");
    if (!context) throw new ModelPreviewError({ code: "model-invalid" });
    context.drawImage(source, 0, 0);
    const scale = this.renderer.getPixelRatio();
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
    this.resizeObserver.disconnect();
    this.visibilityObserver.disconnect();
    this.controls.removeEventListener("change", this.requestRender);
    this.controls.dispose();
    disposeThreeObject(this.scene);
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
