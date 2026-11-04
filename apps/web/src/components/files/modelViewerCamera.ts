/**
 * Orbit camera for the 3D file viewer. It follows Blender's conventions: Z is up, front looks
 * along +Y, axis views switch to orthographic until the next orbit ("Auto Perspective"), and
 * the numpad keys pick views. All functions return new state so the viewer only redraws on change.
 */

export type Vec3 = readonly [number, number, number];

export interface ModelBounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface OrbitCamera {
  readonly target: Vec3;
  /** Rotation around Z; 0 looks from the front (-Y), π/2 from the right (+X). */
  readonly yaw: number;
  /** Elevation above the XY plane. */
  readonly pitch: number;
  readonly distance: number;
  readonly orthographic: boolean;
  /** Set by axis views; the next orbit returns to perspective, as in Blender. */
  readonly autoOrthographic: boolean;
}

const FIELD_OF_VIEW = (40 * Math.PI) / 180;
const PITCH_LIMIT = Math.PI / 2 - 1e-4;
const STEP = (15 * Math.PI) / 180;
const MIN_DISTANCE_RATIO = 1e-3;

export function meshBounds(positions: Float32Array): ModelBounds {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 1) {
    const axis = index % 3;
    const value = positions[index]!;
    if (value < min[axis]!) min[axis] = value;
    if (value > max[axis]!) max[axis] = value;
  }
  return { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] };
}

function boundsRadius(bounds: ModelBounds) {
  return Math.max(
    Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ) / 2,
    1e-6,
  );
}

/**
 * Fits the whole model in view without changing the viewing angle. `aspect` is the viewport's
 * width over height; on a tall, narrow screen the horizontal field of view is the tighter one.
 */
export function frameBounds(camera: OrbitCamera, bounds: ModelBounds, aspect = 1): OrbitCamera {
  const halfAngle = Math.min(
    FIELD_OF_VIEW / 2,
    Math.atan(Math.tan(FIELD_OF_VIEW / 2) * Math.max(aspect, 1e-3)),
  );
  return {
    ...camera,
    target: [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ],
    distance: (boundsRadius(bounds) / Math.sin(halfAngle)) * 1.05,
  };
}

/** The opening view matches the server's preview image: front right, 30 degrees up. */
export function initialCamera(bounds: ModelBounds, aspect = 1): OrbitCamera {
  return frameBounds(
    {
      target: [0, 0, 0],
      yaw: Math.PI / 4,
      pitch: Math.PI / 6,
      distance: 1,
      orthographic: false,
      autoOrthographic: false,
    },
    bounds,
    aspect,
  );
}

function wrapAngle(angle: number) {
  const turn = Math.PI * 2;
  return ((((angle + Math.PI) % turn) + turn) % turn) - Math.PI;
}

export function orbit(camera: OrbitCamera, deltaYaw: number, deltaPitch: number): OrbitCamera {
  return {
    ...camera,
    yaw: wrapAngle(camera.yaw + deltaYaw),
    pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, camera.pitch + deltaPitch)),
    orthographic: camera.autoOrthographic ? false : camera.orthographic,
    autoOrthographic: false,
  };
}

/** Scales the distance; `factor` above 1 moves away. */
export function zoom(camera: OrbitCamera, factor: number, bounds: ModelBounds): OrbitCamera {
  const radius = boundsRadius(bounds);
  return {
    ...camera,
    distance: Math.max(
      radius * MIN_DISTANCE_RATIO,
      Math.min(radius * 1000, camera.distance * factor),
    ),
  };
}

export function cameraDirection(camera: Pick<OrbitCamera, "yaw" | "pitch">): Vec3 {
  return [
    Math.cos(camera.pitch) * Math.sin(camera.yaw),
    -Math.cos(camera.pitch) * Math.cos(camera.yaw),
    Math.sin(camera.pitch),
  ];
}

function cameraAxes(camera: OrbitCamera) {
  const toward = cameraDirection(camera);
  // Right is horizontal; up completes the frame. Pitch stays short of ±90°, so right is defined.
  const right: Vec3 = normalize([-toward[1], toward[0], 0]);
  const up = cross(toward, right);
  return { toward, right, up };
}

/** Moves the target by a drag of `dx`, `dy` pixels in a viewport `height` pixels tall. */
export function pan(camera: OrbitCamera, dx: number, dy: number, height: number): OrbitCamera {
  const { right, up } = cameraAxes(camera);
  const unitsPerPixel = (2 * camera.distance * Math.tan(FIELD_OF_VIEW / 2)) / Math.max(height, 1);
  return {
    ...camera,
    target: [
      camera.target[0] - (right[0] * dx - up[0] * dy) * unitsPerPixel,
      camera.target[1] - (right[1] * dx - up[1] * dy) * unitsPerPixel,
      camera.target[2] - (right[2] * dx - up[2] * dy) * unitsPerPixel,
    ],
  };
}

export type AxisView = "front" | "back" | "right" | "left" | "top" | "bottom";

const AXIS_VIEWS: Record<AxisView, { readonly yaw: number; readonly pitch: number }> = {
  front: { yaw: 0, pitch: 0 },
  back: { yaw: Math.PI, pitch: 0 },
  right: { yaw: Math.PI / 2, pitch: 0 },
  left: { yaw: -Math.PI / 2, pitch: 0 },
  top: { yaw: 0, pitch: PITCH_LIMIT },
  bottom: { yaw: 0, pitch: -PITCH_LIMIT },
};

export function axisView(camera: OrbitCamera, view: AxisView): OrbitCamera {
  return {
    ...camera,
    ...AXIS_VIEWS[view],
    orthographic: true,
    autoOrthographic: !camera.orthographic || camera.autoOrthographic,
  };
}

function toggleOrthographic(camera: OrbitCamera): OrbitCamera {
  return { ...camera, orthographic: !camera.orthographic, autoOrthographic: false };
}

/**
 * Applies Blender's numpad shortcuts. `ctrl` picks the opposite axis view. Returns `null` for keys
 * the viewer does not handle so the event can continue.
 */
export function numpadCommand(
  camera: OrbitCamera,
  code: string,
  modifiers: { readonly ctrl: boolean },
  bounds: ModelBounds,
  aspect = 1,
): OrbitCamera | null {
  switch (code) {
    case "Numpad1":
      return axisView(camera, modifiers.ctrl ? "back" : "front");
    case "Numpad3":
      return axisView(camera, modifiers.ctrl ? "left" : "right");
    case "Numpad7":
      return axisView(camera, modifiers.ctrl ? "bottom" : "top");
    case "Numpad5":
      return toggleOrthographic(camera);
    case "Numpad9":
      return orbit(camera, Math.PI, 0);
    case "Numpad4":
      return orbit(camera, STEP, 0);
    case "Numpad6":
      return orbit(camera, -STEP, 0);
    case "Numpad8":
      return orbit(camera, 0, STEP);
    case "Numpad2":
      return orbit(camera, 0, -STEP);
    case "NumpadAdd":
    case "Equal":
      return zoom(camera, 1 / 1.2, bounds);
    case "NumpadSubtract":
    case "Minus":
      return zoom(camera, 1.2, bounds);
    case "NumpadDecimal":
    case "Home":
      return frameBounds(camera, bounds, aspect);
    default:
      return null;
  }
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Column-major view and projection matrices for WebGL. */
export function cameraMatrices(camera: OrbitCamera, aspect: number, bounds: ModelBounds) {
  const { toward, right, up } = cameraAxes(camera);
  const eye: Vec3 = [
    camera.target[0] + toward[0] * camera.distance,
    camera.target[1] + toward[1] * camera.distance,
    camera.target[2] + toward[2] * camera.distance,
  ];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // prettier-ignore
  const view = new Float32Array([
    right[0], up[0], toward[0], 0,
    right[1], up[1], toward[1], 0,
    right[2], up[2], toward[2], 0,
    -dot(right, eye), -dot(up, eye), -dot(toward, eye), 1,
  ]);
  const radius = boundsRadius(bounds);
  const near = Math.max(camera.distance - radius * 4, camera.distance * 1e-3, radius * 1e-4);
  const far = camera.distance + radius * 4;
  const projection = new Float32Array(16);
  if (camera.orthographic) {
    const top = camera.distance * Math.tan(FIELD_OF_VIEW / 2);
    const rightEdge = top * aspect;
    projection[0] = 1 / rightEdge;
    projection[5] = 1 / top;
    projection[10] = -2 / (far - near);
    projection[14] = -(far + near) / (far - near);
    projection[15] = 1;
  } else {
    const focal = 1 / Math.tan(FIELD_OF_VIEW / 2);
    projection[0] = focal / aspect;
    projection[5] = focal;
    projection[10] = -(far + near) / (far - near);
    projection[11] = -1;
    projection[14] = (-2 * far * near) / (far - near);
  }
  return { view, projection };
}
