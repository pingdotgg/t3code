import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Raycaster,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
  type Camera,
  type Texture,
} from "three";
import type { PhoneDisplayLayout } from "./phoneScene.ts";

const HEIGHT = 2.2;
const DEPTH = 0.075;
const INSET = 0.026;
const CREASE = 0.004;
const BEVEL = 0.008;
// The hinge axis sits just above the inner screens so closed halves meet face to face.
const PIVOT_Z = DEPTH / 2 + 0.005;
const SPINE_RADIUS = PIVOT_Z + DEPTH / 2 - 0.002;
/** Width over height of the unfolded inner display until a live frame reports its own. */
export const DEFAULT_FOLD_INNER_ASPECT = 2076 / 2152;
/** Cover displays are tall phones; unfolded inner displays are near square or landscape. */
export const isFoldInnerAspect = (aspect: number) => Number.isFinite(aspect) && aspect > 0.75;

function panelPath(
  halfWidth: number,
  side: "left" | "right",
  inset: number,
  radius: number,
  hingeInset = 0,
) {
  const left = side === "left" ? -halfWidth + inset : CREASE / 2 + hingeInset;
  const right = side === "left" ? -CREASE / 2 - hingeInset : halfWidth - inset;
  const bottom = -HEIGHT / 2 + inset;
  const top = HEIGHT / 2 - inset;
  const path = new Shape();
  if (side === "left") {
    path.moveTo(left + radius, bottom);
    path.lineTo(right, bottom);
    path.lineTo(right, top);
    path.lineTo(left + radius, top);
    path.quadraticCurveTo(left, top, left, top - radius);
    path.lineTo(left, bottom + radius);
    path.quadraticCurveTo(left, bottom, left + radius, bottom);
  } else {
    path.moveTo(left, bottom);
    path.lineTo(right - radius, bottom);
    path.quadraticCurveTo(right, bottom, right, bottom + radius);
    path.lineTo(right, top - radius);
    path.quadraticCurveTo(right, top, right - radius, top);
    path.lineTo(left, top);
  }
  path.closePath();
  return path;
}

function roundedRectPath(width: number, height: number, radius: number) {
  const path = new Shape();
  path.moveTo(-width / 2 + radius, -height / 2);
  path.lineTo(width / 2 - radius, -height / 2);
  path.quadraticCurveTo(width / 2, -height / 2, width / 2, -height / 2 + radius);
  path.lineTo(width / 2, height / 2 - radius);
  path.quadraticCurveTo(width / 2, height / 2, width / 2 - radius, height / 2);
  path.lineTo(-width / 2 + radius, height / 2);
  path.quadraticCurveTo(-width / 2, height / 2, -width / 2, height / 2 - radius);
  path.lineTo(-width / 2, -height / 2 + radius);
  path.quadraticCurveTo(-width / 2, -height / 2, -width / 2 + radius, -height / 2);
  path.closePath();
  return path;
}

function coverPath(halfWidth: number) {
  return roundedRectPath(halfWidth - INSET * 2 - 0.02, HEIGHT - INSET * 2 - 0.04, 0.07);
}

/**
 * A procedural book-style foldable: one fixed half, one half rotating around a shared hinge.
 * The inner display keeps the raw framebuffer's native aspect, portrait or landscape.
 */
export function createAndroidFoldScene(
  texture: Texture,
  layout: PhoneDisplayLayout,
  initialAngle: number,
  innerAspect = DEFAULT_FOLD_INNER_ASPECT,
) {
  const screenHeight = HEIGHT - 2 * INSET;
  const halfWidth = (innerAspect * screenHeight) / 2 + INSET;
  const root = new Group();
  const orientation = new Group();
  root.add(orientation);
  const left = new Group();
  const right = new Group();
  orientation.add(left, right);
  const frameMetal = new MeshStandardMaterial({
    color: 0xa3abb2,
    metalness: 0.9,
    roughness: 0.28,
  });
  const polishedMetal = new MeshStandardMaterial({
    color: 0xc4cad0,
    metalness: 0.95,
    roughness: 0.16,
  });
  const bezel = new MeshPhysicalMaterial({
    color: 0x0b0d10,
    metalness: 0.1,
    roughness: 0.2,
    clearcoat: 1,
  });
  const backGlass = new MeshPhysicalMaterial({
    color: 0x2c3237,
    metalness: 0.35,
    roughness: 0.52,
    clearcoat: 0.4,
    clearcoatRoughness: 0.6,
  });
  const island = new MeshPhysicalMaterial({
    color: 0x1a1e22,
    metalness: 0.55,
    roughness: 0.3,
    clearcoat: 1,
  });
  const lensMaterial = new MeshPhysicalMaterial({
    color: 0x061022,
    metalness: 0.6,
    roughness: 0.1,
    clearcoat: 1,
  });
  const flashMaterial = new MeshBasicMaterial({ color: 0xf2ead6 });
  const displayMaterial = new MeshBasicMaterial({ map: texture, toneMapped: false });
  const hitMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const coverMaterial = new MeshBasicMaterial({ map: texture, toneMapped: false });
  const materials = [
    frameMetal,
    polishedMetal,
    bezel,
    backGlass,
    island,
    lensMaterial,
    flashMaterial,
    displayMaterial,
    hitMaterial,
    coverMaterial,
  ];

  // Each half's meshes live in body coordinates; `left` pivots them around the hinge axis.
  left.position.z = PIVOT_Z;
  const leftBody = new Group();
  leftBody.position.z = -PIVOT_Z;
  left.add(leftBody);

  function half(group: Group, side: "left" | "right", back: MeshPhysicalMaterial) {
    const body = new Mesh(
      new ExtrudeGeometry(panelPath(halfWidth, side, BEVEL, 0.1, BEVEL), {
        depth: DEPTH - BEVEL * 2,
        bevelEnabled: true,
        bevelSize: BEVEL,
        bevelThickness: BEVEL,
        bevelSegments: 3,
        curveSegments: 12,
      }),
      frameMetal,
    );
    body.position.z = -DEPTH / 2 + BEVEL;
    group.add(body);
    const frame = new Mesh(
      new ShapeGeometry(panelPath(halfWidth, side, 0.01, 0.095, 0.002), 12),
      bezel,
    );
    frame.position.z = DEPTH / 2 + 0.001;
    group.add(frame);
    // A back-facing shape mirrors X, so it is drawn from the opposite side's outline.
    const rear = new Mesh(
      new ShapeGeometry(
        panelPath(halfWidth, side === "left" ? "right" : "left", 0.01, 0.095, 0.002),
        12,
      ),
      back,
    );
    rear.name = `${side}-back`;
    rear.rotation.y = Math.PI;
    rear.position.set(0, 0, -DEPTH / 2 - 0.001);
    group.add(rear);
    const geometry = new ShapeGeometry(panelPath(halfWidth, side, INSET, 0.076));
    geometry.computeBoundingBox();
    const display = new Mesh(geometry, hitMaterial);
    display.name = `${side}-inner-screen`;
    display.position.z = DEPTH / 2 + 0.003;
    group.add(display);
    return display;
  }

  const innerLeft = half(leftBody, "left", bezel);
  const innerRight = half(right, "right", backGlass);
  // One indexed surface keeps adjacent pixels joined at the crease. The
  // physical halves move separately underneath it.
  const screenWidth = 2 * (halfWidth - INSET);
  const screenGeometry = new PlaneGeometry(screenWidth, screenHeight, 40, 48);
  const screenPositions = screenGeometry.getAttribute("position");
  const screenUvs = screenGeometry.getAttribute("uv");
  const baseX = new Float32Array(screenPositions.count);
  for (let i = 0; i < screenPositions.count; i++) {
    const y = screenPositions.getY(i);
    const outerX = screenWidth / 2;
    const outerY = screenHeight / 2;
    const radius = 0.076;
    const cornerY = Math.max(0, Math.abs(y) - (outerY - radius));
    const limit = outerX - radius + Math.sqrt(Math.max(0, radius * radius - cornerY * cornerY));
    const x = Math.max(-limit, Math.min(limit, screenPositions.getX(i)));
    baseX[i] = x;
    screenUvs.setXY(i, x / screenWidth + 0.5, y / screenHeight + 0.5);
  }
  screenUvs.needsUpdate = true;
  const innerSurface = new Mesh(screenGeometry, displayMaterial);
  innerSurface.name = "continuous-inner-screen";
  orientation.add(innerSurface);
  // The outer half of the hinge housing. It tucks behind the back glass when
  // open and becomes the rounded spine when closed.
  const spineSlack = 0.15;
  const spine = new Mesh(
    new CylinderGeometry(
      SPINE_RADIUS,
      SPINE_RADIUS,
      HEIGHT - 0.012,
      32,
      1,
      false,
      Math.PI / 2 + spineSlack,
      Math.PI - spineSlack * 2,
    ),
    polishedMetal,
  );
  spine.name = "hinge-spine";
  spine.position.z = PIVOT_Z;
  orientation.add(spine);

  const cover = new Mesh(new ShapeGeometry(coverPath(halfWidth)), coverMaterial);
  cover.name = "cover-screen";
  cover.position.set(-halfWidth / 2, 0, -DEPTH / 2 - 0.003);
  cover.rotation.y = Math.PI;
  leftBody.add(cover);

  // Rear components use back-surface coordinates, with outward positive Z.
  const rearCamera = new Group();
  rearCamera.name = "rear-camera";
  const islandWidth = 0.46;
  const islandHeight = 0.2;
  rearCamera.position.set(
    halfWidth - 0.07 - islandWidth / 2,
    HEIGHT / 2 - 0.08 - islandHeight / 2,
    -DEPTH / 2 - 0.002,
  );
  rearCamera.rotation.y = Math.PI;
  right.add(rearCamera);
  const plateDepth = 0.02;
  const plate = new Mesh(
    new ExtrudeGeometry(roundedRectPath(islandWidth, islandHeight, 0.07), {
      depth: plateDepth,
      bevelEnabled: true,
      bevelSize: 0.008,
      bevelThickness: 0.006,
      bevelSegments: 3,
      curveSegments: 12,
    }),
    island,
  );
  plate.name = "camera-plate";
  rearCamera.add(plate);
  const plateFront = plateDepth + 0.006;
  for (const [x, radius] of [
    [-0.14, 0.05],
    [-0.01, 0.05],
    [0.105, 0.036],
  ] as const) {
    const ring = new Mesh(
      new CylinderGeometry(radius + 0.012, radius + 0.012, 0.012, 32),
      frameMetal,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, 0, plateFront + 0.004);
    rearCamera.add(ring);
    const lens = new Mesh(new CircleGeometry(radius, 32), lensMaterial);
    lens.name = "camera-lens";
    lens.position.set(x, 0, plateFront + 0.0105);
    rearCamera.add(lens);
  }
  const flash = new Mesh(new CircleGeometry(0.018, 20), flashMaterial);
  flash.position.set(0.185, 0.045, plateFront + 0.0005);
  rearCamera.add(flash);

  // Power and volume keys sit on the fixed half's outer edge.
  for (const [y, length] of [
    [0.52, 0.16],
    [0.2, 0.3],
  ] as const) {
    const key = new Mesh(new BoxGeometry(0.02, length, DEPTH * 0.45), frameMetal);
    key.position.set(halfWidth + 0.008, y, 0);
    right.add(key);
  }

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const local = new Vector3();
  let capturedDisplay: Mesh | null = null;
  let activeLayout = layout;
  let angle = initialAngle;
  const updateVisibleScreen = () => {
    const innerActive = angle >= 90;
    innerSurface.visible = innerActive;
    innerLeft.visible = innerActive;
    innerRight.visible = innerActive;
    cover.visible = !innerActive;
  };
  const setAngle = (next: number) => {
    angle = Math.max(0, Math.min(180, next));
    left.rotation.y = Math.PI * (1 - angle / 180);
    spine.rotation.y = left.rotation.y / 2;
    const radians = left.rotation.y;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const frontZ = DEPTH / 2 + 0.004 - PIVOT_Z;
    for (let i = 0; i < screenPositions.count; i++) {
      const x = baseX[i]!;
      if (x < 0) {
        screenPositions.setXYZ(
          i,
          x * cosine + frontZ * sine,
          screenPositions.getY(i),
          -x * sine + frontZ * cosine + PIVOT_Z,
        );
      } else {
        screenPositions.setXYZ(i, x, screenPositions.getY(i), frontZ + PIVOT_Z);
      }
    }
    screenPositions.needsUpdate = true;
    screenGeometry.computeBoundingBox();
    screenGeometry.computeBoundingSphere();
    updateVisibleScreen();
  };
  const setDisplay = (nextTexture: Texture, nextLayout: PhoneDisplayLayout) => {
    activeLayout = nextLayout;
    displayMaterial.map = nextTexture;
    coverMaterial.map = nextTexture;
    cover.geometry.computeBoundingBox();
    const bounds = cover.geometry.boundingBox!;
    const uv = cover.geometry.getAttribute("uv");
    const position = cover.geometry.getAttribute("position");
    for (let i = 0; i < uv.count; i++) {
      const u = (position.getX(i) - bounds.min.x) / (bounds.max.x - bounds.min.x);
      const v = (position.getY(i) - bounds.min.y) / (bounds.max.y - bounds.min.y);
      uv.setXY(i, u, v);
    }
    uv.needsUpdate = true;
    updateVisibleScreen();
  };
  setAngle(initialAngle);
  setDisplay(texture, layout);

  return {
    root,
    orientation,
    width: halfWidth * 2,
    height: HEIGHT,
    innerAspect,
    setAngle,
    setDisplay,
    screenPoint(x: number, y: number, camera: Camera, captured = false) {
      orientation.updateWorldMatrix(true, true);
      camera.updateMatrixWorld(true);
      pointer.set(x * 2 - 1, 1 - y * 2);
      raycaster.setFromCamera(pointer, camera);
      const screens = cover.visible ? [cover] : [innerLeft, innerRight];
      const hit = raycaster.intersectObjects(screens, false)[0];
      if (!hit && !captured) {
        capturedDisplay = null;
        return null;
      }
      const display =
        (hit?.object as Mesh | undefined) ??
        (capturedDisplay?.visible ? capturedDisplay : screens[0]);
      if (!display) return null;
      if (hit) capturedDisplay = display;
      if (hit) local.copy(hit.point);
      else {
        const plane = new Vector3(0, 0, 1).transformDirection(display.matrixWorld);
        const point = new Vector3().setFromMatrixPosition(display.matrixWorld);
        const distance =
          plane.dot(point.clone().sub(raycaster.ray.origin)) / plane.dot(raycaster.ray.direction);
        if (!Number.isFinite(distance)) return null;
        local.copy(raycaster.ray.direction).multiplyScalar(distance).add(raycaster.ray.origin);
      }
      display.worldToLocal(local);
      const bounds = display.geometry.boundingBox!;
      const u = Math.max(0, Math.min(1, (local.x - bounds.min.x) / (bounds.max.x - bounds.min.x)));
      const v = Math.max(0, Math.min(1, (bounds.max.y - local.y) / (bounds.max.y - bounds.min.y)));
      const across = display === cover ? u : (display === innerLeft ? u : 1 + u) / 2;
      return activeLayout.rotation === Math.PI ? { x: 1 - across, y: 1 - v } : { x: across, y: v };
    },
    dispose() {
      root.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose();
      });
      for (const material of materials) material.dispose();
    },
  };
}
