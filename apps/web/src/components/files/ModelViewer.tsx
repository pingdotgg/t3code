import { isMeshFormat, type ModelPreviewFormat } from "@t3tools/shared/filePreview";
import {
  MODEL_VIEWER_MAX_TRIANGLES,
  parseMesh,
  triangleCount,
  type Mesh as Geometry,
} from "@t3tools/shared/meshFiles";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";

import { FileSurfaceLoading } from "./fileSurfaceChrome";
import {
  cameraMatrices,
  initialCamera,
  meshBounds,
  numpadCommand,
  orbit,
  pan,
  zoom,
  type ModelBounds,
  type OrbitCamera,
} from "./modelViewerCamera";

const ORBIT_RADIANS_PER_PIXEL = 0.008;
const MAX_DEVICE_PIXEL_RATIO = 2;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;
const BASE_COLOR = [176 / 255, 186 / 255, 200 / 255] as const;

const VERTEX_SHADER = `#version 300 es
in vec3 position;
uniform mat4 view;
uniform mat4 projection;
out vec3 viewPosition;
void main() {
  vec4 positioned = view * vec4(position, 1.0);
  viewPosition = positioned.xyz;
  gl_Position = projection * positioned;
}`;

// Face normals come from screen-space derivatives, so the mesh needs no normal buffer. Both sides
// are lit alike because STL winding is unreliable.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 viewPosition;
uniform vec3 baseColor;
out vec4 color;
void main() {
  vec3 normal = normalize(cross(dFdx(viewPosition), dFdy(viewPosition)));
  vec3 light = normalize(vec3(-0.5, 0.6, 1.0));
  color = vec4(baseColor * (0.32 + 0.68 * abs(dot(normal, light))), 1.0);
}`;

/**
 * Decodes a model into indexed geometry, or `null` when it has none. A `.blend` file arrives as
 * the binary PLY the server's Blender exports from it.
 */
function decodeGeometry(format: ModelPreviewFormat, bytes: Uint8Array, signal: AbortSignal) {
  return parseMesh(
    isMeshFormat(format) ? format : "ply",
    bytes,
    { maxTriangles: MODEL_VIEWER_MAX_TRIANGLES },
    signal,
  );
}

function compileProgram(gl: WebGL2RenderingContext) {
  const shader = (type: number, source: string) => {
    const compiled = gl.createShader(type)!;
    gl.shaderSource(compiled, source);
    gl.compileShader(compiled);
    if (!gl.getShaderParameter(compiled, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(compiled) ?? "Shader failed to compile.");
    }
    return compiled;
  };
  const program = gl.createProgram();
  const vertex = shader(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "Shader failed to link.");
  }
  return program;
}

interface Mesh {
  /** Released once the GPU holds a copy, so large models are not kept twice. */
  readonly geometry: { current: Geometry | null };
  readonly bounds: ModelBounds;
  readonly triangles: number;
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly mesh: Mesh }
  | { readonly status: "failed" };

/**
 * Interactive view of a 3D file with Blender's controls: middle or left drag orbits, Shift pans,
 * Ctrl zooms, the wheel zooms, and the numpad picks views. It draws only when the view changes.
 * `onUnavailable` reports files it cannot show so the caller can fall back to the preview image.
 * For `.blend` files, `loadBytes` supplies the geometry the server exported from them.
 */
export default function ModelViewer(props: {
  readonly name: string;
  readonly format: ModelPreviewFormat;
  readonly loadBytes: (signal: AbortSignal) => Promise<Uint8Array>;
  readonly onUnavailable: (reason: string) => void;
  readonly loadingLabel?: string | null | undefined;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const loadMesh = useEffectEvent(async (signal: AbortSignal): Promise<Mesh> => {
    const bytes = await props.loadBytes(signal);
    const geometry = await decodeGeometry(props.format, bytes, signal);
    if (!geometry) throw new Error("This file has no geometry the 3D view can draw.");
    const bounds = meshBounds(geometry.points);
    if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) {
      throw new Error("This file has coordinates the 3D view cannot draw.");
    }
    return { geometry: { current: geometry }, bounds, triangles: triangleCount(geometry) };
  });
  const reportUnavailable = useEffectEvent((reason: string) => props.onUnavailable(reason));

  // Callers remount the viewer with a new `key` for a different file.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- downloads and decodes the model once per mount, aborting on unmount
  useEffect(() => {
    const controller = new AbortController();
    loadMesh(controller.signal).then(
      (mesh) => {
        if (!controller.signal.aborted) setState({ status: "ready", mesh });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "failed" });
        reportUnavailable(cause instanceof Error ? cause.message : "The 3D view is unavailable.");
      },
    );
    return () => controller.abort();
  }, []);

  if (state.status === "loading") return <FileSurfaceLoading label={props.loadingLabel} />;
  if (state.status === "failed") return null;
  return <ModelCanvas name={props.name} mesh={state.mesh} onUnavailable={props.onUnavailable} />;
}

/**
 * Draws `mesh` into `canvas` and wires Blender's controls. Returns a cleanup function, or `null`
 * after reporting why when the device cannot draw it.
 */
function mountModelCanvas(
  canvas: HTMLCanvasElement,
  mesh: Mesh,
  handlers: {
    readonly onUnavailable: (reason: string) => void;
  },
): (() => void) | null {
  const gl = canvas.getContext("webgl2", {
    antialias: true,
    alpha: true,
    premultipliedAlpha: true,
  });
  if (!gl) {
    handlers.onUnavailable("This browser cannot show 3D views.");
    return null;
  }
  if (gl.isContextLost()) {
    handlers.onUnavailable("The 3D view stopped because the graphics device was reset.");
    return null;
  }
  const geometry = mesh.geometry.current;
  if (!geometry) {
    handlers.onUnavailable("Reopen the file to show it in 3D again.");
    return null;
  }
  const { bounds } = mesh;
  const aspect = () => canvas.clientWidth / Math.max(canvas.clientHeight, 1) || 1;
  let camera = initialCamera(bounds, aspect());
  let program: WebGLProgram;
  try {
    program = compileProgram(gl);
  } catch (cause) {
    console.error("3D view shaders failed", cause);
    handlers.onUnavailable("This device cannot show 3D views.");
    return null;
  }
  const buffer = gl.createBuffer();
  const indexBuffer = geometry.indices ? gl.createBuffer() : null;
  const vertexArray = gl.createVertexArray();
  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.points, gl.STATIC_DRAW);
  if (indexBuffer && geometry.indices) {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
  }
  const positionLocation = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
  const viewLocation = gl.getUniformLocation(program, "view");
  const projectionLocation = gl.getUniformLocation(program, "projection");
  const colorLocation = gl.getUniformLocation(program, "baseColor");
  const cornerCount = geometry.indices
    ? geometry.indices.length
    : Math.floor(geometry.points.length / 9) * 3;

  // Bound under another name so React lint does not read WebGL's useProgram as a hook.
  const activateProgram = gl.useProgram.bind(gl);
  let frame = 0;
  const render = () => {
    frame = 0;
    const width = canvas.width;
    const height = canvas.height;
    if (width === 0 || height === 0) return;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    activateProgram(program);
    const { view, projection } = cameraMatrices(camera, width / height, bounds);
    gl.uniformMatrix4fv(viewLocation, false, view);
    gl.uniformMatrix4fv(projectionLocation, false, projection);
    gl.uniform3f(colorLocation, ...BASE_COLOR);
    gl.bindVertexArray(vertexArray);
    if (indexBuffer) gl.drawElements(gl.TRIANGLES, cornerCount, gl.UNSIGNED_INT, 0);
    else gl.drawArrays(gl.TRIANGLES, 0, cornerCount);
  };
  // Coalesce input into at most one draw per frame; nothing runs while the view is still.
  const draw = () => {
    if (frame === 0) frame = requestAnimationFrame(render);
  };

  const stopObservingSize = observeResize(canvas, () => {
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    draw();
  });

  const set = (next: OrbitCamera) => {
    camera = next;
    draw();
  };

  // Trackpads scroll in pixels with fractional or sideways deltas: two fingers orbit (Shift
  // pans) and pinching zooms, as in Blender. Mouse wheels zoom.
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const trackpad =
      event.deltaMode === 0 && (event.deltaX !== 0 || !Number.isInteger(event.deltaY));
    if (event.ctrlKey || !trackpad) {
      set(zoom(camera, Math.exp(event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), bounds));
    } else if (event.shiftKey) {
      set(pan(camera, -event.deltaX, -event.deltaY, canvas.clientHeight));
    } else {
      set(
        orbit(
          camera,
          event.deltaX * ORBIT_RADIANS_PER_PIXEL,
          event.deltaY * ORBIT_RADIANS_PER_PIXEL,
        ),
      );
    }
  };

  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number; x: number; y: number } | null = null;
  // Touch has no Home key, so a double tap returns to the opening view.
  let lastTap: { time: number; x: number; y: number } | null = null;
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return a && b
      ? { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      : null;
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 1) return;
    if (event.button === 1) event.preventDefault();
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (event.pointerType === "touch" && pointers.size === 1) {
      const tap = { time: event.timeStamp, x: event.clientX, y: event.clientY };
      const repeated =
        lastTap !== null &&
        tap.time - lastTap.time < DOUBLE_TAP_MS &&
        Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < DOUBLE_TAP_SLOP_PX;
      lastTap = repeated ? null : tap;
      if (repeated) set(initialCamera(bounds, aspect()));
    }
    pinch = pointers.size === 2 ? pinchState() : null;
  };
  const onPointerMove = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2 && pinch) {
      const next = pinchState();
      if (!next) return;
      let moved = zoom(camera, pinch.distance / Math.max(next.distance, 1), bounds);
      moved = pan(moved, next.x - pinch.x, next.y - pinch.y, canvas.clientHeight);
      pinch = next;
      set(moved);
      return null;
    }
    if (event.shiftKey) set(pan(camera, dx, dy, canvas.clientHeight));
    else if (event.ctrlKey) set(zoom(camera, Math.exp(dy * 0.01), bounds));
    else set(orbit(camera, -dx * ORBIT_RADIANS_PER_PIXEL, dy * ORBIT_RADIANS_PER_PIXEL));
  };
  const onPointerUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    pinch = pointers.size === 2 ? pinchState() : null;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const next = numpadCommand(camera, event.code, { ctrl: event.ctrlKey }, bounds, aspect());
    if (!next) return;
    event.preventDefault();
    set(next);
  };
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("keydown", onKeyDown);
  const onContextLost = (event: Event) => {
    event.preventDefault();
    handlers.onUnavailable("The 3D view stopped because the graphics device was reset.");
  };
  canvas.addEventListener("webglcontextlost", onContextLost);

  const destroy = () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    stopObservingSize();
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("keydown", onKeyDown);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    gl.deleteBuffer(buffer);
    if (indexBuffer) gl.deleteBuffer(indexBuffer);
    gl.deleteVertexArray(vertexArray);
    gl.deleteProgram(program);
    // The context stays alive: a canvas keeps one context for life, so losing it here would leave
    // a remount on the same canvas (React Strict Mode, a new mesh) unable to draw.
  };
  return destroy;
}

function ModelCanvas(props: {
  readonly name: string;
  readonly mesh: Mesh;
  readonly onUnavailable: (reason: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Callers pass a stable callback, so reporting does not recreate the WebGL context.
  const { mesh, onUnavailable } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the WebGL context, input listeners, and resize observer for the canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const destroy = mountModelCanvas(canvas, mesh, {
      onUnavailable,
    });
    // The GPU now holds the geometry. Release the CPU copy after React finishes mounting, since
    // Strict Mode mounts twice and the second mount uploads again.
    const release = destroy
      ? setTimeout(() => {
          mesh.geometry.current = null;
        }, 0)
      : undefined;
    return () => {
      clearTimeout(release);
      destroy?.();
    };
  }, [mesh, onUnavailable]);

  const triangles = props.mesh.triangles;
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-muted/30">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`3D view of ${props.name}`}
        tabIndex={0}
        className="size-full touch-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/60"
        onContextMenu={(event) => event.preventDefault()}
      />
      <span className="pointer-events-none absolute top-2 left-2 rounded-sm bg-background/80 px-1.5 py-0.5 text-2xs text-muted-foreground">
        {triangles.toLocaleString()} triangles
      </span>
    </div>
  );
}
