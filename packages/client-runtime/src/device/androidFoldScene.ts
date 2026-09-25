import {
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
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

const HALF_WIDTH = 1.04;
const HEIGHT = 2.2;
const DEPTH = 0.075;
const INSET = 0.026;
const CREASE = 0.004;

function panelPath(side: "left" | "right", inset: number, radius: number) {
  const left = side === "left" ? -HALF_WIDTH + inset : CREASE / 2;
  const right = side === "left" ? -CREASE / 2 : HALF_WIDTH - inset;
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

function coverPath() {
  const width = HALF_WIDTH - INSET * 2;
  const height = HEIGHT - INSET * 2;
  const radius = 0.075;
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

/** A deliberately simple foldable: one fixed half, one half rotating around a shared hinge. */
export function createAndroidFoldScene(
  texture: Texture,
  layout: PhoneDisplayLayout,
  initialAngle: number,
) {
  const root = new Group();
  const orientation = new Group();
  root.add(orientation);
  const left = new Group();
  const right = new Group();
  orientation.add(left, right);
  const shell = new MeshStandardMaterial({ color: 0x48545b, metalness: 0.65, roughness: 0.38 });
  const bezel = new MeshStandardMaterial({ color: 0x14191c, metalness: 0.22, roughness: 0.5 });
  const displayMaterial = new MeshBasicMaterial({ map: texture, toneMapped: false });
  const hitMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const coverMaterial = new MeshBasicMaterial({ map: texture, toneMapped: false });
  const materials = [shell, bezel, displayMaterial, hitMaterial, coverMaterial];

  function half(group: Group, side: "left" | "right") {
    const body = new Mesh(
      new ExtrudeGeometry(panelPath(side, 0, 0.105), {
        depth: DEPTH,
        bevelEnabled: false,
        curveSegments: 12,
      }),
      shell,
    );
    body.position.z = -DEPTH / 2;
    group.add(body);
    const frame = new Mesh(new ShapeGeometry(panelPath(side, 0.009, 0.096)), bezel);
    frame.position.z = DEPTH / 2 + 0.001;
    group.add(frame);
    const geometry = new ShapeGeometry(panelPath(side, INSET, 0.076));
    geometry.computeBoundingBox();
    const display = new Mesh(geometry, hitMaterial);
    display.name = `${side}-inner-screen`;
    display.position.z = DEPTH / 2 + 0.003;
    group.add(display);
    return display;
  }

  const innerLeft = half(left, "left");
  const innerRight = half(right, "right");
  // One indexed surface keeps adjacent pixels joined at the crease. The
  // physical halves move separately underneath it.
  const screenWidth = 2 * (HALF_WIDTH - INSET);
  const screenHeight = HEIGHT - 2 * INSET;
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
  const hinge = new Mesh(new CylinderGeometry(0.016, 0.016, HEIGHT - 0.05, 16), shell);
  hinge.position.z = -DEPTH / 2 - 0.01;
  orientation.add(hinge);
  const cover = new Mesh(new ShapeGeometry(coverPath()), coverMaterial);
  cover.name = "cover-screen";
  cover.position.set(-HALF_WIDTH / 2, 0, -DEPTH / 2 - 0.003);
  cover.rotation.y = Math.PI;
  left.add(cover);

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
    // Keep the cover slightly in front of the fixed half when closed.
    left.position.z = 0.01 * (1 - angle / 180);
    const radians = left.rotation.y;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const frontZ = DEPTH / 2 + 0.004;
    for (let i = 0; i < screenPositions.count; i++) {
      const x = baseX[i]!;
      if (x < 0) {
        screenPositions.setXYZ(
          i,
          x * cosine + frontZ * sine,
          screenPositions.getY(i),
          -x * sine + frontZ * cosine + left.position.z,
        );
      } else {
        screenPositions.setXYZ(i, x, screenPositions.getY(i), frontZ);
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
    width: HALF_WIDTH * 2,
    height: HEIGHT,
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
