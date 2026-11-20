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
  InstancedMesh,
  LoadingManager,
  Material,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { decodeDataUrl } from "../dataUrl.ts";
import { disposeThreeObject } from "../three/disposeObject.ts";
import { isZipError } from "../zip/zipError.ts";
import {
  modelCameraStatus,
  type ModelCameraView,
  type ModelCapture,
  type ModelNote,
  type Vec3,
} from "./annotations.ts";
import { unpackModelArchive } from "./archive.ts";
import { ModelPreviewError } from "./error.ts";

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
      signal.throwIfAborted();
      if (bytes.byteLength < 84) throw new ModelPreviewError({ code: "model-invalid" });
      const faces = new DataView(bytes).getUint32(80, true);
      // Match STLLoader's ASCII detection before trusting a binary face count for allocations.
      const asciiHeader = String.fromCharCode(...new Uint8Array(bytes, 0, 9)).includes("solid");
      if (84 + faces * 50 > bytes.byteLength && !asciiHeader) {
        throw new ModelPreviewError({ code: "model-invalid" });
      }
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
      const textureUrls = new Set<string>();
      const manager = new LoadingManager().setURLModifier((url) => {
        textureUrls.add(url);
        return url;
      });
      let onAbort: (() => void) | undefined;
      let content: Object3D | undefined;
      try {
        content = new ThreeMFLoader(manager).parse(archive);
        // Parsing starts image loads synchronously, but their textures become usable asynchronously.
        if (textureUrls.size > 0) {
          signal.throwIfAborted();
          await new Promise<void>((resolve, reject) => {
            manager.onLoad = resolve;
            manager.onError = () => reject(new ModelPreviewError({ code: "model-invalid" }));
            onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
          });
        }
        return content;
      } catch (error) {
        if (content) disposeThreeObject(content);
        throw error;
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
        // ThreeMFLoader revokes these on image load. Failed or cancelled loads also need cleanup.
        for (const url of textureUrls) URL.revokeObjectURL(url);
      }
    }
    case "glb": {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      signal.throwIfAborted();
      const inlineResources = new Map<string, string>();
      const manager = new LoadingManager().setURLModifier((url) => {
        signal.throwIfAborted();
        if (/^blob:/i.test(url)) return url;
        const objectUrl = inlineResources.get(url);
        if (objectUrl) return objectUrl;
        throw new ModelPreviewError({ code: "model-invalid" });
      });
      const abort = () => manager.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const gltf = await new GLTFLoader(manager)
          .register((parser) => ({
            name: "self-contained-preview",
            beforeRoot: () => {
              signal.throwIfAborted();
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
        signal.removeEventListener("abort", abort);
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
    triangles += Math.floor(count / 3) * (object instanceof InstancedMesh ? object.count : 1);
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
   * Rejects with a preview or archive error, or the signal's reason.
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
    } catch (cause) {
      input.signal.throwIfAborted();
      if (isZipError(cause)) throw cause;
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
    return modelCameraStatus(this.view);
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
    const meshToContent = new Matrix4().multiplyMatrices(toContent, hit.object.matrixWorld);
    if (hit.instanceId !== undefined && hit.object instanceof InstancedMesh) {
      const instanceToMesh = new Matrix4();
      hit.object.getMatrixAt(hit.instanceId, instanceToMesh);
      meshToContent.multiply(instanceToMesh);
    }
    const normal = hit.face.normal
      .clone()
      .applyNormalMatrix(new Matrix3().getNormalMatrix(meshToContent));
    return {
      point: toVec3(hit.point.clone().applyMatrix4(toContent)),
      normal: toVec3(normal),
      face: hit.faceIndex ?? 0,
    };
  }

  /** Where each note sits on the canvas, in CSS pixels from its top left corner. */
  project(notes: ReadonlyArray<Pick<ModelNote, "point" | "normal">>): ProjectedPin[] {
    const { width, height } = this.renderer.getSize(new Vector2());
    const normalMatrix = new Matrix3().getNormalMatrix(this.content.matrixWorld);
    return notes.map((note) => {
      const world = new Vector3(...note.point).applyMatrix4(this.content.matrixWorld);
      const normal = new Vector3(...note.normal).applyNormalMatrix(normalMatrix);
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
    // Pin evidence is retained across visits, even on high-DPI screens.
    const downscale = Math.min(1, 1280 / Math.max(source.width, source.height));
    canvas.width = Math.max(1, Math.round(source.width * downscale));
    canvas.height = Math.max(1, Math.round(source.height * downscale));
    const context = canvas.getContext("2d");
    if (!context) throw new ModelPreviewError({ code: "model-invalid" });
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const scale = this.renderer.getPixelRatio() * downscale;
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
      context.fillText(String(note.number), x, y + 0.5 * scale);
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
